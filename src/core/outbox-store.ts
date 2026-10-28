// Durable store-backed outbox persistence, leases, and revision counters.
import { JSON_STRINGIFY } from './json-intrinsics.js';
import { cloneJsonTransportPayload } from './native-payload.js';
import { createHash, randomUUID } from 'node:crypto';
import { ActiveContext, assertOutsideActiveTransaction } from './context.js';
import { ActiveTsConflictError, ActiveTsConfigurationError, ActiveTsNotFoundError, ActiveTsValidationError, safeErrorMessage } from './errors.js';
import { assertSafeCacheKey, ACTIVE_TS_ENTITY_KEY, defineDataProperty } from './safe-keys.js';
import { entityIdKey } from './query-utils.js';
import { datastoreSearchDocumentIdentity } from './search-utils.js';
import { dateIsoString, dateTime } from './date-intrinsics.js';
import { OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, OBJECT_GET_OWN_PROPERTY_NAMES, OBJECT_GET_OWN_PROPERTY_SYMBOLS, OBJECT_GET_PROTOTYPE_OF } from './object-intrinsics.js';
import { contextInternalStore } from './context-internal.js';
import { normalizeStoreQueryResultForModel } from './store-options.js';
import { normalizeSchemaModels, normalizeSchemaPlan } from './schema-utils.js';
import { normalizeStoreSchemaApplyOptions } from './schema-options.js';
import type { EntityId, QueryPlan, ResolvedModelMeta, SchemaPlan, StoreAdapter } from './types.js';
import type { OutboxAdapter, OutboxBatchOptions, OutboxDeliveryFailure, OutboxEvent, StoreOutboxAdapterOptions, StoreOutboxSchemaApplyOptions } from './outbox-types.js';
import { assertKnownOptions, assertNoSymbolOptions, assertNonNegativeSafeInteger, assertPlainOptions, assertPositiveSafeInteger, normalizeOutboxBatchLimit, ownOptionValue, sanitizeOutboxDeliveryFailureBatch, sanitizeOutboxEvent, sanitizeOutboxEventBatch, validateStoreOutboxAdapterOptions } from './outbox-validation.js';
import { STORE_OUTBOX_LEASE_TTL_MS, STORE_OUTBOX_SEARCH_REVISION_TIME_SCALE, blockOutboxEntityOrderKeys, copyEventsReversed, isOutboxDeliveryAvailable, isOutboxLeaseActive, isOutboxLeaseCurrent, isOutboxRequeueInsertCurrent, isOutboxSnapshotCurrent, outboxDeadLetterEvent, outboxEntityOrderBlockKeys, outboxEntityOrderCheckKeys, outboxEntityOrderKeysBlocked, outboxExpectedVersionOption, outboxRetryEvent, withOutboxLease, withStoreOutboxSequence, withoutOutboxLease } from './outbox-protocol.js';

export class StoreOutboxEventModel {}

export class StoreOutboxSearchRevisionModel {}

export class StoreOutboxAdapter implements OutboxAdapter {
	readonly transactionStore!: string;
	private context?: ActiveContext;
	private readonly meta: ResolvedModelMeta;
	private readonly revisionMeta: ResolvedModelMeta;

	constructor(options: StoreOutboxAdapterOptions) {
		const safeOptions = validateStoreOutboxAdapterOptions(options);
		this.context = safeOptions.context;
		this.meta = createStoreOutboxMeta(safeOptions.store, safeOptions.modelName);
		this.revisionMeta = createStoreOutboxSearchRevisionMeta(safeOptions.store, safeOptions.revisionModelName);
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

	async schemaPlan(): Promise<SchemaPlan> {
		assertOutsideActiveTransaction('plan store outbox schema changes');
		const context = this.activeContext();
		context.assertOutsideTransaction('plan store outbox schema changes');
		const store = contextInternalStore(context, this.meta.store);
		if (!store.schema) {
			throw new ActiveTsConfigurationError(
				`Store outbox adapter store "${store.kind}" does not expose schema hooks.`
			);
		}
		return normalizeSchemaPlan(
			await store.schema.plan(this.schemaModels()),
			`Store outbox adapter store "${store.kind}" schema plan`
		);
	}

	async schemaApply(options: StoreOutboxSchemaApplyOptions = {}): Promise<SchemaPlan> {
		assertOutsideActiveTransaction('apply store outbox schema changes');
		const context = this.activeContext();
		context.assertOutsideTransaction('apply store outbox schema changes');
		const store = contextInternalStore(context, this.meta.store);
		if (!store.schema) {
			throw new ActiveTsConfigurationError(
				`Store outbox adapter store "${store.kind}" does not expose schema hooks.`
			);
		}
		const applyOptions = normalizeStoreSchemaApplyOptions(options, 'Store outbox adapter schema apply options');
		return normalizeSchemaPlan(
			await store.schema.apply(this.schemaModels(), applyOptions),
			`Store outbox adapter store "${store.kind}" schema apply plan`
		);
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

	async reserveSearchRevision(event: OutboxEvent, documentIdentity?: string) {
		const normalized = sanitizeOutboxEvent(event, { requireModelId: true });
		if (normalized.leaseToken === undefined) {
			throw new ActiveTsConfigurationError('Store outbox reserveSearchRevision requires a leased event.');
		}
		const safeDocumentIdentity = documentIdentity === undefined
			? undefined
			: assertSafeCacheKey(documentIdentity, 'Store outbox search document identity');
		const context = this.activeContext();
		const store = contextInternalStore(context, this.meta.store);
		const run = async (activeContext: ActiveContext, revalidateLease: boolean) => {
			const current = await this.currentOutboxEvent(activeContext, normalized.id);
			if (
				!current ||
				!isOutboxSnapshotCurrent(current, normalized) ||
				!isOutboxLeaseCurrent(current, normalized.leaseToken!, new Date())
			) {
				return undefined;
			}
			const revisionStore = contextInternalStore(activeContext, this.revisionMeta.store);
			const revisionId = storeOutboxSearchRevisionId(normalized, safeDocumentIdentity);
			const rawRevision = await revisionStore.get(this.revisionMeta, revisionId);
			let revision: number;
			if (rawRevision === null || rawRevision === undefined) {
				revision = initialStoreOutboxSearchRevision();
				await revisionStore.create(this.revisionMeta, revisionId, { id: revisionId, revision, version: 0 });
			} else {
				const currentRevision = sanitizeStoreOutboxSearchRevision(rawRevision, revisionId);
				if (
					currentRevision.revision >= Number.MAX_SAFE_INTEGER ||
					currentRevision.version >= Number.MAX_SAFE_INTEGER
				) {
					throw new ActiveTsConflictError(
						`Store outbox search revision is exhausted for event "${normalized.id}".`
					);
				}
				revision = currentRevision.revision + 1;
				const next = { id: revisionId, revision, version: currentRevision.version + 1 };
				await revisionStore.update(
					this.revisionMeta,
					revisionId,
					next,
					store.capabilities?.optimisticLock === true
						? { expectedVersion: currentRevision.version }
						: undefined
				);
			}
			if (revalidateLease) {
				const latest = await this.currentOutboxEvent(activeContext, normalized.id);
				if (
					!latest ||
					!isOutboxSnapshotCurrent(latest, normalized) ||
					!isOutboxLeaseCurrent(latest, normalized.leaseToken!, new Date())
				) {
					return undefined;
				}
			}
			return revision;
		};
		try {
			if (store.capabilities?.optimisticLock === true) return await run(context, true);
			if (storeSupportsOutboxLeaseTransactions(store)) {
				return await context.transaction((tx) => run(tx, false), { store: this.meta.store });
			}
			throw new ActiveTsConfigurationError(
				`Store outbox adapter requires store "${store.kind}" to support optimistic locking or conflict-detecting transactions for search revision reservations.`
			);
		} catch (error) {
			if (isStoreOutboxLeaseClaimConflict(store, error)) {
				if (!(await this.isLeaseCurrent(normalized))) return undefined;
			}
			throw error;
		}
	}

	private schemaModels() {
		return normalizeSchemaModels(
			[this.meta, this.revisionMeta],
			'Store outbox adapter schema models'
		);
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

export function createStoreOutboxMeta(store: string, modelName: string): ResolvedModelMeta {
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

export function createStoreOutboxSearchRevisionMeta(store: string, modelName: string): ResolvedModelMeta {
	return {
		model: StoreOutboxSearchRevisionModel,
		name: modelName,
		store,
		idField: 'id',
		readValidation: 'off',
		indexes: [],
		searchIndexes: [],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: new Map(),
		fieldTypes: new Map([
			['revision', 'number'],
			['version', 'number']
		])
	};
}

export function sanitizeStoreOutboxEvent(event: OutboxEvent, options: { requireModelId: boolean }) {
	return sanitizeOutboxEvent(stripStoreOutboxEntityKey(event), options);
}

export function sanitizeStoreOutboxSearchRevision(value: unknown, expectedId: string) {
	value = stripStoreOutboxEntityKey(value);
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError('Store outbox search revision row must be a plain object.');
	}
	assertPlainOptions(value, 'Store outbox search revision row');
	const record = value as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Store outbox search revision row');
	assertKnownOptions(record, ['id', 'revision', 'version'], 'Store outbox search revision row');
	const id = assertSafeCacheKey(ownOptionValue(record, 'id', 'Store outbox search revision row'), 'Store outbox search revision id');
	if (id !== expectedId) {
		throw new ActiveTsValidationError(
			`Store outbox search revision id "${id}" does not match requested id "${expectedId}".`
		);
	}
	return {
		id,
		revision: assertPositiveSafeInteger(
			ownOptionValue(record, 'revision', 'Store outbox search revision row'),
			'Store outbox search revision'
		),
		version: assertNonNegativeSafeInteger(
			ownOptionValue(record, 'version', 'Store outbox search revision row'),
			'Store outbox search revision version'
		)
	};
}

export function stripStoreOutboxEntityKey<T>(value: T): T {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
	const symbols = OBJECT_GET_OWN_PROPERTY_SYMBOLS(value);
	if (symbols.length !== 1 || symbols[0] !== ACTIVE_TS_ENTITY_KEY) return value;
	const clone = Object.create(OBJECT_GET_PROTOTYPE_OF(value));
	for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
		if (descriptor) {
			Object.defineProperty(clone, key, descriptor);
		}
	}
	return clone as T;
}

export function storeOutboxSearchRevisionId(event: OutboxEvent, documentIdentity: string | undefined) {
	if (
		documentIdentity !== undefined &&
		event.modelIdentity !== undefined &&
		documentIdentity !== event.modelIdentity
	) {
		throw new ActiveTsValidationError(
			`Store outbox search document identity does not match event "${event.id}".`
		);
	}
	const identity = documentIdentity ?? event.modelIdentity ?? (
		event.modelDatastoreAncestor === undefined && event.modelDatastoreScope === undefined
			? entityIdKey(event.modelId!)
			: datastoreSearchDocumentIdentity({ name: event.model, datastoreSearchScope: event.modelDatastoreScope }, event.modelId!, event.modelDatastoreAncestor)
	);
	return createHash('sha256')
		.update(JSON_STRINGIFY(cloneJsonTransportPayload([event.model, identity])))
		.digest('hex');
}

export function initialStoreOutboxSearchRevision() {
	const revision = dateTime(new Date()) * STORE_OUTBOX_SEARCH_REVISION_TIME_SCALE;
	if (!Number.isSafeInteger(revision) || revision <= 0) {
		throw new ActiveTsConflictError('Store outbox search revision clock is outside the supported range.');
	}
	return revision;
}

export function storeSupportsOutboxManagementTransactions(store: StoreAdapter) {
	if (store.kind === 'datastore') return false;
	return typeof store.transaction === 'function' && store.capabilities?.transaction === true;
}

export function storeSupportsOutboxLeaseTransactions(store: StoreAdapter) {
	return typeof store.transaction === 'function' &&
		store.capabilities?.transaction === true &&
		store.capabilities.transactionConflictDetection === true;
}

export function isStoreOutboxLeaseClaimConflict(store: StoreAdapter, error: unknown) {
	if (error instanceof ActiveTsConflictError || error instanceof ActiveTsNotFoundError) return true;
	if (store.kind !== 'datastore' || !error || typeof error !== 'object' || Array.isArray(error)) return false;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(error, 'code');
	if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
	return descriptor.value === 10 || descriptor.value === 'aborted' || descriptor.value === 'ABORTED';
}

export function outboxListQueryPlan(options: { limit?: number; cursor?: string } = {}): QueryPlan {
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
