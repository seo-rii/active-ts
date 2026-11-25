// Shared event ordering, physical identity, and lease invariants.
import { JSON_STRINGIFY } from './json-intrinsics.js';
import { cloneJsonTransportPayload } from './native-payload.js';
import { datastoreSearchScopeForStore } from './datastore-search-scope.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ActiveContext } from './context.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import { assertSafeCacheKey, assertSafeEntityId, assertSafeSchemaIdentifier, ACTIVE_TS_ENTITY_KEY, cloneSafeDataObject } from './safe-keys.js';
import { entityIdKey, valueFor } from './query-utils.js';
import { datastoreSearchDocumentIdentity, withDatastoreSearchNamespace } from './search-utils.js';
import { datastoreAncestorFromEntityKey, datastoreKeyIdentity, datastoreKeyWithNamespace } from './datastore-key.js';
import { dateIsoString, dateParse, dateTime } from './date-intrinsics.js';
import { SET_ADD, SET_HAS } from './collection-intrinsics.js';
import { OBJECT_GET_OWN_PROPERTY_DESCRIPTOR } from './object-intrinsics.js';
import { contextInternalStore } from './context-internal.js';
import { datastorePayloadHasAncestorFields, datastorePayloadResolvedAncestor } from './store-options.js';
import type { DatastoreKey, EntityId, ResolvedModelMeta } from './types.js';
import type { OutboxBatchOptions, OutboxDeliveryFailure, OutboxDeliveryIdentitySnapshot, OutboxEvent, OutboxEventIdentity } from './outbox-types.js';
import { sanitizeOutboxEvent } from './outbox-validation.js';

export const DEFAULT_STORE_OUTBOX_MODEL_NAME = 'active_ts_outbox_event';

export const DEFAULT_STORE_OUTBOX_SEARCH_REVISION_MODEL_NAME = 'active_ts_search_revision';

export const STORE_OUTBOX_LEASE_TTL_MS = 5 * 60 * 1000;

export const STORE_OUTBOX_SEARCH_REVISION_TIME_SCALE = 1024;

export const DEFAULT_SEARCH_SYNC_MAX_ATTEMPTS = 5;

export const DEFAULT_SEARCH_SYNC_RETRY_DELAY_MS = 0;

export const MAX_SEARCH_SYNC_RETRY_DELAY_MS = 60_000;

export const STALE_SEARCH_SYNC_LEASE_RELEASE_ERROR = Symbol('active-ts.outbox.stale-search-sync-lease-release-error');

export let storeOutboxSequence = 0;

export function withStoreOutboxSequence(event: OutboxEvent): OutboxEvent {
	return {
		...event,
		sequence: event.sequence ?? nextStoreOutboxSequence(),
		version: event.version ?? 0
	};
}

export function withOutboxLease(event: OutboxEvent, leaseToken: string, leaseExpiresAt: string): OutboxEvent {
	return {
		...event,
		version: outboxEventVersion(event) + 1,
		leaseToken,
		leaseExpiresAt
	};
}

export function withoutOutboxLease(event: OutboxEvent): OutboxEvent {
	const next: OutboxEvent = {
		...event,
		version: outboxEventVersion(event) + 1
	};
	delete next.leaseToken;
	delete next.leaseExpiresAt;
	return next;
}

export function outboxExpectedVersionOption(event: OutboxEvent) {
	return event.version === undefined ? undefined : { expectedVersion: event.version };
}

export function outboxEventVersion(event: OutboxEvent) {
	return event.version ?? 0;
}

export function isOutboxLeaseActive(event: OutboxEvent, now: Date) {
	if (event.leaseToken === undefined || event.leaseExpiresAt === undefined) return false;
	return dateParse(event.leaseExpiresAt) > dateTime(now);
}

export function isOutboxLeaseCurrent(event: OutboxEvent, leaseToken: string, now: Date) {
	return event.leaseToken === leaseToken && isOutboxLeaseActive(event, now);
}

export function isOutboxDeliveryAvailable(event: OutboxEvent, now: Date) {
	return event.availableAt === undefined || dateParse(event.availableAt) <= dateTime(now);
}

export function isOutboxSnapshotCurrent(current: OutboxEvent, snapshot: OutboxEvent) {
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
		current.modelDatastoreScope === snapshot.modelDatastoreScope &&
		current.dataEncoding === snapshot.dataEncoding &&
		current.reconcileFromStore === snapshot.reconcileFromStore &&
		outboxDatastoreAncestorMatches(current.modelDatastoreAncestor, snapshot.modelDatastoreAncestor) &&
		outboxEntityIdMatches(current.modelId, snapshot.modelId) &&
		isDeepStrictEqual(current.data, snapshot.data);
}

export function isOutboxRequeueInsertCurrent(current: OutboxEvent, inserted: OutboxEvent) {
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
		current.modelDatastoreScope === inserted.modelDatastoreScope &&
		current.dataEncoding === inserted.dataEncoding &&
		current.reconcileFromStore === inserted.reconcileFromStore &&
		outboxDatastoreAncestorMatches(current.modelDatastoreAncestor, inserted.modelDatastoreAncestor) &&
		outboxEntityIdMatches(current.modelId, inserted.modelId) &&
		isDeepStrictEqual(current.data, inserted.data);
}

export function outboxEntityIdMatches(left: EntityId | undefined, right: EntityId | undefined) {
	if (left === undefined || right === undefined) return left === right;
	return entityIdKey(left) === entityIdKey(right);
}

export function outboxDatastoreAncestorMatches(left: DatastoreKey | undefined, right: DatastoreKey | undefined) {
	if (left === undefined || right === undefined) return left === right;
	return datastoreKeyIdentity(left) === datastoreKeyIdentity(right);
}

export function outboxEntityOrderKeys(event: OutboxEvent) {
	const keys: string[] = [];
	if (event.modelIdentity !== undefined) keys[keys.length] = `${event.model}:${event.modelIdentity}`;
	if ((event.modelDatastoreAncestor !== undefined || event.modelDatastoreScope !== undefined) && event.modelId !== undefined) {
		const ancestorIdentity = datastoreSearchDocumentIdentity(
			{ name: event.model, datastoreSearchScope: event.modelDatastoreScope },
			event.modelId,
			event.modelDatastoreAncestor
		);
		keys[keys.length] = `${event.model}:${ancestorIdentity}`;
	}
	if (keys.length) return keys;
	if (event.modelId === undefined) return [`event:${event.id}`];
	return [`${event.model}:${entityIdKey(event.modelId)}`];
}

export function snapshotOutboxDeliveryIdentity(value: unknown, index: number): OutboxDeliveryIdentitySnapshot {
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

export function outboxOwnDataValue(value: object, property: string) {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, property);
	return descriptor && 'value' in descriptor && descriptor.enumerable ? descriptor.value : undefined;
}

export function isSafeOutboxCacheKey(value: string) {
	try {
		assertSafeCacheKey(value, 'outbox delivery identity');
		return true;
	} catch {
		return false;
	}
}

export function isSafeOutboxSchemaIdentifier(value: string) {
	try {
		assertSafeSchemaIdentifier(value, 'outbox delivery identity');
		return true;
	} catch {
		return false;
	}
}

export function isSafeOutboxEntityId(value: string | number): value is EntityId {
	try {
		assertSafeEntityId(value, 'outbox delivery identity');
		return true;
	} catch {
		return false;
	}
}

export function isCanonicalOutboxTimestamp(value: string) {
	const timestamp = dateParse(value);
	return Number.isFinite(timestamp) && dateIsoString(new Date(timestamp)) === value;
}

export function outboxIdentityOrderKeys(identity: OutboxEventIdentity, index: number) {
	if (identity.model !== undefined && identity.modelIdentity !== undefined) {
		return [`${identity.model}:${identity.modelIdentity}`];
	}
	if (identity.model !== undefined && identity.modelId !== undefined) {
		return [`${identity.model}:${entityIdKey(identity.modelId)}`];
	}
	if (identity.id !== undefined) return [`event:${identity.id}`];
	return [`malformed:${index}`];
}

export function outboxEntityOrderCheckKeys(event: OutboxEvent) {
	const keys = outboxEntityOrderKeys(event);
	const identityOnlyAlias = outboxIdentityOnlyDatastoreCheckAliasKey(event);
	if (identityOnlyAlias !== undefined) appendOutboxEntityOrderKey(keys, identityOnlyAlias);
	const namespaceLessAncestorAlias = outboxNamespaceLessDatastoreAncestorCheckAliasKey(event);
	if (namespaceLessAncestorAlias !== undefined) appendOutboxEntityOrderKey(keys, namespaceLessAncestorAlias);
	return keys;
}

export function outboxEntityOrderBlockKeys(event: OutboxEvent) {
	const keys = outboxEntityOrderKeys(event);
	const identityOnlyAlias = outboxIdentityOnlyDatastoreBlockAliasKey(event);
	if (identityOnlyAlias !== undefined) appendOutboxEntityOrderKey(keys, identityOnlyAlias);
	const namespaceLessAncestorAlias = outboxNamespaceLessDatastoreAncestorBlockAliasKey(event);
	if (namespaceLessAncestorAlias !== undefined) appendOutboxEntityOrderKey(keys, namespaceLessAncestorAlias);
	return keys;
}

export function outboxIdentityOnlyDatastoreCheckAliasKey(event: OutboxEvent) {
	return outboxIsDatastoreIdentityOnlyEvent(event)
		? outboxDatastoreAliasKey(event, 'namespace-less-ancestor')
		: undefined;
}

export function outboxIdentityOnlyDatastoreBlockAliasKey(event: OutboxEvent) {
	return outboxIsDatastoreIdentityOnlyEvent(event)
		? outboxDatastoreAliasKey(event, 'identity-only')
		: undefined;
}

export function outboxNamespaceLessDatastoreAncestorCheckAliasKey(event: OutboxEvent) {
	return outboxIsNamespaceLessDatastoreAncestorEvent(event)
		? outboxDatastoreAliasKey(event, 'identity-only')
		: undefined;
}

export function outboxNamespaceLessDatastoreAncestorBlockAliasKey(event: OutboxEvent) {
	return outboxIsNamespaceLessDatastoreAncestorEvent(event)
		? outboxDatastoreAliasKey(event, 'namespace-less-ancestor')
		: undefined;
}

export function outboxIsDatastoreIdentityOnlyEvent(event: OutboxEvent) {
	return event.modelId !== undefined &&
		event.modelDatastoreAncestor === undefined &&
		event.modelIdentity !== undefined &&
		event.modelIdentity.startsWith('datastore:');
}

export function outboxIsNamespaceLessDatastoreAncestorEvent(event: OutboxEvent) {
	return event.modelId !== undefined &&
		event.modelDatastoreAncestor !== undefined &&
		event.modelDatastoreAncestor.namespace === undefined;
}

export function outboxDatastoreAliasKey(event: OutboxEvent, kind: 'identity-only' | 'namespace-less-ancestor') {
	return `${event.model}:datastore-${kind}-namespace-alias:${JSON_STRINGIFY(cloneJsonTransportPayload([event.modelDatastoreScope ?? null, entityIdKey(event.modelId!)]))}`;
}

export function appendOutboxEntityOrderKey(keys: string[], key: string) {
	for (let index = 0; index < keys.length; index++) {
		if (keys[index] === key) return;
	}
	keys[keys.length] = key;
}

export function outboxEntityOrderKeysBlocked(blockedEntityKeys: Set<string>, orderKeys: string[]) {
	for (let index = 0; index < orderKeys.length; index++) {
		if (SET_HAS.call(blockedEntityKeys, orderKeys[index])) return true;
	}
	return false;
}

export function blockOutboxEntityOrderKeys(blockedEntityKeys: Set<string>, orderKeys: string[]) {
	for (let index = 0; index < orderKeys.length; index++) {
		SET_ADD.call(blockedEntityKeys, orderKeys[index]);
	}
}

export function nextStoreOutboxSequence() {
	storeOutboxSequence = storeOutboxSequence >= Number.MAX_SAFE_INTEGER ? 1 : storeOutboxSequence + 1;
	return `${Date.now().toString(36).padStart(10, '0')}:${storeOutboxSequence
		.toString(36)
		.padStart(10, '0')}:${randomUUID()}`;
}

export function copyEvents<T>(events: readonly T[], start = 0, end = events.length) {
	const result: T[] = [];
	for (let index = start; index < end && index < events.length; index++) {
		result[result.length] = events[index];
	}
	return result;
}

export function copyEventsReversed<T>(events: readonly T[]) {
	const result: T[] = [];
	for (let index = events.length - 1; index >= 0; index--) {
		result[result.length] = events[index];
	}
	return result;
}

export function normalizeSearchIndexEventData(
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

export function outboxEventSearchDocumentIdentity(
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
		const scopedIdentity = meta.datastoreSearchScope === undefined ? undefined : datastoreSearchDocumentIdentity(meta, event.modelId!, undefined);
		if (event.modelIdentity !== undefined && event.modelIdentity !== scopedIdentity) {
			throw new ActiveTsConfigurationError(
				`Outbox event "${event.id}" for non-Datastore model "${meta.name}" cannot include model identity metadata.`
			);
		}
		return scopedIdentity;
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

export function outboxEventDataDatastoreAncestor(
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

export function outboxEventEntityKeyDatastoreAncestor(
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

export function outboxEventPayloadDatastoreAncestor(
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

export function outboxEventPayloadHasAncestorFields(meta: ResolvedModelMeta, data: unknown) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
	if (!meta.datastore?.ancestorFields?.length) return true;
	return datastorePayloadHasAncestorFields(meta, data);
}

export function outboxScopedMeta(context: unknown, meta: ResolvedModelMeta): ResolvedModelMeta {
	if (!(context instanceof ActiveContext)) return meta;
	const store = contextInternalStore(context, meta.store);
	return withDatastoreSearchNamespace(meta, store.datastoreNamespace, datastoreSearchScopeForStore(store));
}

export function datastoreNamespaceForContext(
	context: ActiveContext | undefined | unknown,
	meta: ResolvedModelMeta | undefined
) {
	if (!(context instanceof ActiveContext) || !meta) return undefined;
	return contextInternalStore(context, meta.store).datastoreNamespace;
}

export function datastoreProjectIdForContext(
	context: ActiveContext | undefined | unknown,
	meta: ResolvedModelMeta | undefined
) {
	if (!(context instanceof ActiveContext) || !meta) return undefined;
	return contextInternalStore(context, meta.store).datastoreProjectId;
}

export function assertOutboxDatastoreProjectId(
	context: ActiveContext | undefined,
	meta: ResolvedModelMeta,
	event: OutboxEvent
) {
	if (event.modelDatastoreScope !== meta.datastoreSearchScope &&
		(event.modelDatastoreProjectId === undefined || event.modelDatastoreProjectId === datastoreProjectIdForContext(context, meta))) {
		throw new ActiveTsConfigurationError(`Outbox event "${event.id}" Datastore scope does not match its context; rebuild legacy or differently scoped events before delivery.`);
	}
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

export function drainResultEntriesForRequeue(value: unknown[]) {
	const events: OutboxEvent[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index));
		if (descriptor && 'value' in descriptor) events.push(descriptor.value as OutboxEvent);
	}
	return events;
}

export function outboxBatchOptions(batchSize: number | undefined): OutboxBatchOptions | undefined {
	return batchSize === undefined ? undefined : { limit: batchSize };
}

export function outboxRetryEvent(failure: OutboxDeliveryFailure) {
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

export function outboxDeadLetterEvent(failure: OutboxDeliveryFailure) {
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
