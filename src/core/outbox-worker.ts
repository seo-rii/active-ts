// Search delivery orchestration, reconciliation, and lease renewal.
import { randomUUID } from 'node:crypto';
import { ActiveContext, assertOutsideActiveTransaction } from './context.js';
import { ActiveTsConflictError, ActiveTsConfigurationError, ActiveTsValidationError, safeErrorMessage } from './errors.js';
import { cloneSafeData, cloneSafeDataObjectWithoutActiveEntityKey, defineDataProperty } from './safe-keys.js';
import { snapshotArrayInput } from './array-input.js';
import { searchAdapterUsesProjection, withSearchDocumentIdentity, withSearchIndexesForAdapter, withDatastoreSearchNamespace } from './search-utils.js';
import { dateIsoString, dateParse } from './date-intrinsics.js';
import { MAP_GET, MAP_HAS, MAP_SET } from './collection-intrinsics.js';
import { OBJECT_GET_OWN_PROPERTY_DESCRIPTOR } from './object-intrinsics.js';
import { contextInternalStore } from './context-internal.js';
import { normalizeStoreQueryResultForModel, storeTrustsDatastoreEntityKeyRows } from './store-options.js';
import type { EntityId, ModelConstructor, QueryPlan, ResolvedModelMeta, SearchAdapter } from './types.js';
import type { OutboxAdapter, OutboxDeliveryFailure, OutboxDrainRecoverySnapshot, OutboxEvent, PendingSearchSyncDeferredEvent, PendingSearchSyncFailure, SearchSyncAdapterRoute, SearchSyncMutation, SearchSyncWorkerOptions } from './outbox-types.js';
import { assertNonNegativeSafeInteger, assertPositiveSafeInteger, assertSearchSyncLeaseContract, sanitizeOutboxDeliveryFailure, sanitizeOutboxDrainResult, sanitizeOutboxEvent, validateSearchSyncWorkerOptions } from './outbox-validation.js';
import { legacyOutboxMeta, outboxModelName, resolveSearchSyncAdapterRoutes } from './outbox-routing.js';
import { DEFAULT_SEARCH_SYNC_RETRY_DELAY_MS, MAX_SEARCH_SYNC_RETRY_DELAY_MS, STALE_SEARCH_SYNC_LEASE_RELEASE_ERROR, assertOutboxDatastoreProjectId, blockOutboxEntityOrderKeys, copyEvents, datastoreNamespaceForContext, drainResultEntriesForRequeue, isOutboxSnapshotCurrent, nextStoreOutboxSequence, normalizeSearchIndexEventData, outboxBatchOptions, outboxEntityIdMatches, outboxEntityOrderBlockKeys, outboxEntityOrderCheckKeys, outboxEntityOrderKeysBlocked, outboxEventSearchDocumentIdentity, outboxEventVersion, outboxRetryEvent, outboxScopedMeta, snapshotOutboxDeliveryIdentity } from './outbox-protocol.js';
import { ackOutboxEvents, ackOutboxSnapshots, captureOutboxDrainRecoverySnapshot, recoverFailedOutboxDrain, recoverOverflowedOutboxBatch, releaseOutboxEvents, requeueOutboxEvents } from './outbox-recovery.js';

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
		if (activeOptions.allowUnsafeUnfencedSearchWrites !== true) {
			if (!activeOptions.outbox.reserveSearchRevision) {
				throw new ActiveTsConfigurationError(
					'Outbox search sync leased delivery requires outbox.reserveSearchRevision(). Pass allowUnsafeUnfencedSearchWrites: true to acknowledge stale external write risk.'
				);
			}
			for (const model of activeOptions.models) {
				const meta = activeOptions.context.meta(model);
				const routes = resolveSearchSyncAdapterRoutes(
					activeOptions.context,
					meta,
					activeOptions.adapter,
					activeOptions.search,
					activeOptions.searchSource
				);
				for (const route of routes) {
					if (route.adapter.capabilities?.revisionWrites === true) continue;
					throw new ActiveTsConfigurationError(
						`Outbox search sync adapter "${route.name}" does not support revision-ordered writes. Pass allowUnsafeUnfencedSearchWrites: true to acknowledge stale external write risk.`
					);
				}
			}
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
		let searchRevision: number | undefined;
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
			const meta = outboxScopedMeta(activeOptions.context, activeOptions.context ? activeOptions.context.meta(model) : legacyOutboxMeta(model, event.model));
			assertOutboxDatastoreProjectId(activeOptions.context, meta, event);
			const searchRoutes = resolveSearchSyncAdapterRoutes(
				activeOptions.context,
				meta,
				activeOptions.adapter,
				activeOptions.search,
				activeOptions.searchSource
			);
			let reservedIdentity: string | undefined;
			if (usesLease && activeOptions.outbox.reserveSearchRevision) {
				// Reserve before any authoritative read so an older snapshot can never
				// receive a newer fence than a concurrently reconciled document.
				reservedIdentity = searchSyncReservationIdentity(
					activeOptions.context, meta, event, activeOptions.allowUnsafeIdentityOnlyDatastoreDelete
				);
				const reserved = await activeOptions.outbox.reserveSearchRevision(event, reservedIdentity);
				if (reserved === undefined) {
					if (await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, true)) {
						throw new ActiveTsConflictError(
							`Outbox event "${event.id}" could not reserve a search revision while its lease remained current.`
						);
					}
					blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(event));
					continue;
				}
				searchRevision = assertPositiveSafeInteger(
					reserved,
					`Outbox event "${event.id}" reserved search revision`
				);
			}
			const mutation = await resolveSearchSyncMutation(
				activeOptions.context,
				model,
				meta,
				event,
				activeOptions.searchSource,
				activeOptions.allowUnsafeIdentityOnlyDatastoreDelete,
				event.reconcileFromStore === true
			);
			if (searchRevision !== undefined && mutation.identity !== reservedIdentity) {
				throw new ActiveTsConflictError(`Outbox event "${event.id}" search identity changed after revision reservation.`);
			}
			repair = usesLease && searchRoutes.length
				? await enqueueSearchSyncRepair(activeOptions.outbox, event)
				: undefined;
			for (let routeIndex = 0; routeIndex < searchRoutes.length; routeIndex++) {
				const searchRoute = searchRoutes[routeIndex];
				const routeRevision = searchRoute.adapter.capabilities?.revisionWrites === true
					? searchRevision
					: undefined;
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
					() => executeSearchSyncMutation(
						searchRoute.adapter,
						searchEventMeta,
						event!,
						mutation,
						routeRevision
					)
				);
				event = mutationResult.event;
				events[index] = event;
				if (mutationResult.mutationFailed) throw mutationResult.mutationError;
				if (!mutationResult.current) {
					preserveRepair = true;
					if (routeRevision === undefined) {
						const repairMutation = await resolveSearchSyncMutation(
							activeOptions.context!,
							model,
							meta,
							repair!.event,
							activeOptions.searchSource,
							activeOptions.allowUnsafeIdentityOnlyDatastoreDelete,
							true
						);
						const repairMeta = searchSyncEventMeta(
							activeOptions.context,
							meta,
							searchRoute,
							repairMutation.identity
						);
						await executeSearchSyncMutation(
							searchRoute.adapter,
							repairMeta,
							repair!.event,
							repairMutation
						);
					}
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

export async function settleSearchSyncFailures(
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

export async function createSearchSyncDeliveryFailure(
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

export async function searchSyncRetryDelay(
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

export function outboxDeliveryErrorMessage(error: unknown) {
	let message = safeErrorMessage(error).replaceAll('\0', '\\0');
	if (!message) message = '<empty error message>';
	while (Buffer.byteLength(message, 'utf8') > 4_096) {
		message = message.slice(0, Math.max(1, Math.floor(message.length * 0.75)));
	}
	return message;
}

export function orderPendingOutboxRecoveries(events: PendingSearchSyncDeferredEvent[]) {
	const ordered: PendingSearchSyncDeferredEvent[] = [];
	for (const event of events) {
		let insertAt = ordered.length;
		while (insertAt > 0 && ordered[insertAt - 1].index > event.index) insertAt--;
		for (let index = ordered.length; index > insertAt; index--) ordered[index] = ordered[index - 1];
		ordered[insertAt] = event;
	}
	return ordered;
}

export function searchSyncReservationIdentity(
	context: ActiveContext | undefined,
	meta: ResolvedModelMeta,
	event: OutboxEvent,
	allowUnsafeIdentityOnlyDatastoreDelete: boolean | undefined
) {
	let data = event.data;
	// Immutable event metadata is sufficient when present. Never load the row
	// here: the document fence must precede that read.
	if (!meta.datastore?.ancestor || event.modelDatastoreAncestor !== undefined) {
		data = undefined;
	} else if (data !== undefined) {
		if (event.dataEncoding === 'stored') {
			if (!context) throw new ActiveTsConfigurationError(`Outbox event "${event.id}" stores encoded data and requires a context for search indexing.`);
			data = context.validateRead(meta, data);
		} else if (context) {
			data = context.validateDecodedRead(meta, data);
		}
		data = normalizeSearchIndexEventData(event, meta, data);
	}
	return outboxEventSearchDocumentIdentity(event, meta, data, datastoreNamespaceForContext(context, meta), {
		allowUnsafeIdentityOnlyDatastoreDelete
	});
}

export async function resolveSearchSyncMutation(
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

export function searchSyncEventMeta(
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

export async function executeSearchSyncMutation(
	search: SearchAdapter,
	meta: ResolvedModelMeta,
	event: OutboxEvent,
	mutation: SearchSyncMutation,
	revision?: number
) {
	if (mutation.operation === 'delete') {
		await search.delete(meta, event.modelId!, revision === undefined ? undefined : { revision });
		return;
	}
	await search.index(meta, event.modelId!, mutation.data, revision === undefined ? undefined : { revision });
}

export async function enqueueSearchSyncRepair(outbox: OutboxAdapter, event: OutboxEvent) {
	const repairEvent = sanitizeOutboxEvent({
		id: randomUUID(),
		model: event.model,
		modelId: event.modelId,
		modelIdentity: event.modelIdentity,
		modelDatastoreAncestor: event.modelDatastoreAncestor,
		modelDatastoreProjectId: event.modelDatastoreProjectId,
		modelDatastoreScope: event.modelDatastoreScope,
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

export async function runSearchSyncMutationWithLease(
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

export function searchSyncLeaseRenewalInterval(event: OutboxEvent) {
	if (event.leaseExpiresAt === undefined) return 30_000;
	const remaining = dateParse(event.leaseExpiresAt) - Date.now();
	return Math.max(1, Math.min(30_000, Math.floor(remaining / 3)));
}

export function assertOutboxLeaseRenewal(previous: OutboxEvent, renewed: OutboxEvent) {
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

export async function loadSearchSyncEventData(context: ActiveContext, meta: ResolvedModelMeta, event: OutboxEvent) {
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

export async function ensureSearchSyncLeaseCurrent(outbox: OutboxAdapter, event: OutboxEvent, usesLease: boolean) {
	if (!usesLease || !outbox.isLeaseCurrent) return true;
	if (await outbox.isLeaseCurrent(event)) return true;
	const releaseErrors = await releaseOutboxEvents(outbox, [event]);
	if (releaseErrors.length) throw staleSearchSyncLeaseReleaseError(event, releaseErrors);
	return false;
}

export function staleSearchSyncLeaseReleaseError(event: OutboxEvent, errors: unknown[]) {
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

export function isStaleSearchSyncLeaseReleaseError(error: unknown) {
	if (!error || typeof error !== 'object') return false;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(error, STALE_SEARCH_SYNC_LEASE_RELEASE_ERROR);
	return !!descriptor && 'value' in descriptor && descriptor.value === true;
}

export async function runSearchIndexHook(
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

export function snapshotSearchIndexHookModel(model: ResolvedModelMeta): ResolvedModelMeta {
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
