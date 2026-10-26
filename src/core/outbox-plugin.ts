// Model hooks that append committed mutations to the outbox.
import { randomUUID } from 'node:crypto';
import { ActiveContext } from './context.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import { assertSafeCacheKey, assertSafeSchemaIdentifier, cloneSafeData } from './safe-keys.js';
import { datastoreSearchDocumentIdentity } from './search-utils.js';
import { datastoreKeyWithNamespace, normalizeDatastoreKey } from './datastore-key.js';
import { dateIsoString } from './date-intrinsics.js';
import { MAP_SIZE } from './collection-intrinsics.js';
import { OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, OBJECT_HAS_OWN } from './object-intrinsics.js';
import { contextInternalStore } from './context-internal.js';
import { storeAdapterSourceChain } from './store-utils.js';
import { MODEL_DATASTORE_WRITE_ANCESTOR } from './model-internal.js';
import type { ActiveTsPlugin, EntityId, ResolvedModelMeta, StoreAdapter } from './types.js';
import type { OutboxOperation, OutboxPluginOptions } from './outbox-types.js';
import { ownOptionValue, sanitizeOutboxEvent, validateOutboxPluginOptions } from './outbox-validation.js';
import { datastoreNamespaceForContext, datastoreProjectIdForContext, outboxScopedMeta } from './outbox-protocol.js';

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
		const rawMeta = resolvedOutboxMeta(model);
		const resolvedMeta = rawMeta ? outboxScopedMeta(context, rawMeta) : undefined;
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
			modelDatastoreScope: resolvedMeta?.datastoreSearchScope,
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

export function outboxHookModelName(model: unknown) {
	if (model === undefined || model === null) return undefined;
	if (typeof model !== 'object' || Array.isArray(model)) {
		throw new ActiveTsValidationError('Outbox hook model must be a plain object.');
	}
	return assertSafeSchemaIdentifier(
		ownOptionValue(model as Record<string, unknown>, 'name', 'Outbox hook model'),
		'Outbox hook model name'
	);
}

export async function committedOutboxPayload(
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

export function outboxDirectIdReadUnsafe(model: ResolvedModelMeta) {
	return model.datastore?.ancestor !== undefined;
}

export function outboxTransactionDeferredAppendUnsafeStore(
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

export function outboxDatastoreIdentity(
	model: ResolvedModelMeta | undefined,
	modelId: EntityId | undefined,
	data: any,
	target?: unknown,
	namespace?: string
) {
	if (!model || modelId === undefined) {
		return { modelIdentity: undefined, modelDatastoreAncestor: undefined };
	}
	if (!model.datastore?.ancestor) {
		return { modelIdentity: model.datastoreSearchScope === undefined ? undefined : datastoreSearchDocumentIdentity(model, modelId, undefined), modelDatastoreAncestor: undefined };
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

export function outboxTargetDatastoreAncestor(target: unknown) {
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

export function requiresStoredOutboxPayload(model: ResolvedModelMeta) {
	return MAP_SIZE.call(model.fieldCodecs) > 0 || MAP_SIZE.call(model.fieldTypes) > 0;
}

export function resolvedOutboxMeta(model: unknown): ResolvedModelMeta | undefined {
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
