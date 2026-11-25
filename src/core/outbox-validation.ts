// Input snapshots and validation for outbox events, adapters, and options.
import { normalizeDatastoreSearchScope } from './datastore-search-scope.js';
import { ActiveContext, isContextBoundSearchAdapter } from './context.js';
import { ActiveTsConfigurationError } from './errors.js';
import { assertSafeCacheKey, assertSafeEntityId, assertSafeSchemaIdentifier, cloneSafeData } from './safe-keys.js';
import { snapshotArrayInput } from './array-input.js';
import { normalizeDatastoreKey } from './datastore-key.js';
import { dateIsoString, dateParse } from './date-intrinsics.js';
import { SET_ADD, SET_HAS } from './collection-intrinsics.js';
import { OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, OBJECT_GET_OWN_PROPERTY_NAMES, OBJECT_GET_OWN_PROPERTY_SYMBOLS, OBJECT_GET_PROTOTYPE_OF, OBJECT_HAS_OWN } from './object-intrinsics.js';
import type { EntityId, ModelConstructor, SearchAdapter, SearchCapabilities } from './types.js';
import type { OutboxAdapter, OutboxBatchOptions, OutboxDeliveryFailure, OutboxEvent, OutboxEventIdentity, OutboxOperation, OutboxPluginOptions, SearchSyncWorkerOptions, StoreOutboxAdapterOptions } from './outbox-types.js';
import { DEFAULT_SEARCH_SYNC_MAX_ATTEMPTS, DEFAULT_STORE_OUTBOX_MODEL_NAME, DEFAULT_STORE_OUTBOX_SEARCH_REVISION_MODEL_NAME } from './outbox-protocol.js';

export const OUTBOX_PLUGIN_OPTION_KEYS = ['outbox', 'includeData', 'id', 'allowUnsafeTransactionDeferredAppend'] as const;

export const SEARCH_SYNC_WORKER_OPTION_KEYS = [
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
	'allowUnsafeIdentityOnlyDatastoreDelete',
	'allowUnsafeUnfencedSearchWrites'
] as const;

export const STORE_OUTBOX_ADAPTER_OPTION_KEYS = ['context', 'store', 'modelName', 'revisionModelName'] as const;

export const SEARCH_SYNC_CAPABILITY_KEYS: Array<Exclude<keyof SearchCapabilities, 'whereOperators'>> = [
	'where',
	'nestedFields',
	'numericComparisons',
	'nullOperators',
	'cursor',
	'native',
	'index',
	'revisionWrites'
];

export const SEARCH_SYNC_WHERE_OPERATOR_KEYS = [
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

export const SEARCH_SYNC_WHERE_OPERATORS = stringSet(SEARCH_SYNC_WHERE_OPERATOR_KEYS);

export const OUTBOX_EVENT_KEYS = [
	'id',
	'model',
	'modelId',
	'modelIdentity',
	'modelDatastoreAncestor',
	'modelDatastoreProjectId',
	'modelDatastoreScope',
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

export function validateStoreOutboxAdapterOptions(options: StoreOutboxAdapterOptions) {
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
	const revisionModelName = ownOptionValue(record, 'revisionModelName', 'Store outbox adapter options');
	if (context !== undefined && !(context instanceof ActiveContext)) {
		throw new ActiveTsConfigurationError('Store outbox adapter context must be an ActiveContext.');
	}
	const safeModelName = modelName === undefined
		? DEFAULT_STORE_OUTBOX_MODEL_NAME
		: assertSafeSchemaIdentifier(modelName, 'Store outbox adapter modelName');
	const safeRevisionModelName = revisionModelName === undefined
		? DEFAULT_STORE_OUTBOX_SEARCH_REVISION_MODEL_NAME
		: assertSafeSchemaIdentifier(revisionModelName, 'Store outbox adapter revisionModelName');
	if (safeRevisionModelName === safeModelName) {
		throw new ActiveTsConfigurationError(
			'Store outbox adapter revisionModelName must differ from modelName.'
		);
	}
	return {
		context,
		store: store === undefined ? 'default' : assertSafeSchemaIdentifier(store, 'Store outbox adapter store'),
		modelName: safeModelName,
		revisionModelName: safeRevisionModelName
	};
}

export function validateOutboxPluginOptions(options: OutboxPluginOptions) {
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

export function validateSearchSyncWorkerOptions(options: SearchSyncWorkerOptions): SearchSyncWorkerOptions & {
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
	const allowUnsafeUnfencedSearchWrites = ownOptionValue(
		record,
		'allowUnsafeUnfencedSearchWrites',
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
	if (allowUnsafeUnfencedSearchWrites !== undefined && typeof allowUnsafeUnfencedSearchWrites !== 'boolean') {
		throw new ActiveTsConfigurationError(
			'Outbox search sync allowUnsafeUnfencedSearchWrites must be a boolean.'
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
		allowUnsafeIdentityOnlyDatastoreDelete: allowUnsafeIdentityOnlyDatastoreDelete as boolean | undefined,
		allowUnsafeUnfencedSearchWrites: allowUnsafeUnfencedSearchWrites as boolean | undefined
	} as SearchSyncWorkerOptions & {
		outbox: OutboxAdapter;
		searchSource: SearchAdapter;
		maxAttempts: number;
	};
}

export function normalizeOutboxEvent(event: unknown): OutboxEvent {
	return sanitizeOutboxEvent(event, { requireModelId: false });
}

export function sanitizeOutboxEvent(event: unknown, options: { requireModelId: boolean }): OutboxEvent {
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
	const modelDatastoreScope = normalizeDatastoreSearchScope(ownOptionValue(record, 'modelDatastoreScope', 'Outbox event'));
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
	if (modelDatastoreScope !== undefined) normalized.modelDatastoreScope = modelDatastoreScope;
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

export function sanitizeOutboxDrainResult(value: unknown) {
	if (!Array.isArray(value)) {
		throw new ActiveTsConfigurationError('Outbox drain result must be an array.');
	}
	return snapshotArrayInput<OutboxEvent>(value, 'Outbox drain result');
}

export function assertNoSymbolOptions(record: Record<string, unknown>, context: string) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(record).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
}

export function assertPlainOptions(value: object, context: string) {
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
}

export function assertKnownOptions(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedSet = stringSet(allowed);
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(record)) {
		if (!SET_HAS.call(allowedSet, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

export function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function ownOptionValue(record: Record<string, unknown>, key: string, context: string) {
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

export function normalizeOutboxAdapter(value: unknown, context: string, requireDrain: boolean): OutboxAdapter {
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
	const reserveSearchRevision = adapterMember(value, 'reserveSearchRevision');
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
	if (reserveSearchRevision !== undefined && typeof reserveSearchRevision !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.reserveSearchRevision must be a function.`);
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
		reserveSearchRevision: typeof reserveSearchRevision === 'function'
			? reserveSearchRevision.bind(value)
			: undefined,
		renewLease: typeof renewLease === 'function' ? renewLease.bind(value) : undefined,
		release: typeof release === 'function' ? release.bind(value) : undefined,
		ack: typeof ack === 'function' ? ack.bind(value) : undefined,
		retry: typeof retry === 'function' ? retry.bind(value) : undefined,
		deadLetter: typeof deadLetter === 'function' ? deadLetter.bind(value) : undefined,
		drain: typeof drain === 'function' ? drain.bind(value) : undefined,
		requeue: typeof requeue === 'function' ? requeue.bind(value) : undefined
	};
}

export function assertSearchSyncLeaseContract(outbox: OutboxAdapter, context: string) {
	if (!outbox.isLeaseCurrent || !outbox.release || !outbox.retry) {
		throw new ActiveTsConfigurationError(
			`${context}.lease, ${context}.ack, ${context}.isLeaseCurrent, ${context}.release, and ${context}.retry must be configured together for search sync.`
		);
	}
}

export function normalizeSearchSyncAdapter(value: unknown): SearchAdapter {
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

export function normalizeSearchSyncCapabilities(value: unknown, kind: string): SearchCapabilities {
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

export function assertKnownSearchSyncCapabilityKeys(
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

export function isSearchSyncWhereOperator(value: string): value is keyof NonNullable<SearchCapabilities['whereOperators']> {
	return SET_HAS.call(SEARCH_SYNC_WHERE_OPERATORS, value);
}

export function assertSearchSyncAdapterKind(value: unknown, context: string) {
	if (typeof value !== 'string' || !value || value.includes('\0')) {
		throw new ActiveTsConfigurationError(`${context} must be a non-empty string without null bytes.`);
	}
	return value;
}

export function assertPositiveSafeInteger(value: unknown, context: string) {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new ActiveTsConfigurationError(`${context} must be a positive safe integer.`);
	}
	return value;
}

export function assertNonNegativeSafeInteger(value: unknown, context: string) {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new ActiveTsConfigurationError(`${context} must be a non-negative safe integer.`);
	}
	return value;
}

export function normalizeOutboxBatchLimit(options: OutboxBatchOptions | undefined, context: string) {
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

export function adapterMember(adapter: object, property: string, options: { allowOwnAccessor?: boolean } = {}) {
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

export function optionalAdapterMember(adapter: object, property: string) {
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

export function assertCanonicalIsoTimestamp(value: unknown, context: string) {
	const text = assertSafeCacheKey(value, context);
	const timestamp = dateParse(text);
	if (!Number.isFinite(timestamp) || dateIsoString(new Date(timestamp)) !== text) {
		throw new ActiveTsConfigurationError(`${context} must be a canonical ISO timestamp.`);
	}
	return text;
}

export function sanitizeOutboxEventBatch(events: OutboxEvent[], context: string) {
	const safeEvents = snapshotArrayInput<OutboxEvent>(events, context);
	const normalized: OutboxEvent[] = [];
	for (let index = 0; index < safeEvents.length; index++) {
		normalized[index] = sanitizeOutboxEvent(safeEvents[index], { requireModelId: false });
	}
	return normalized;
}

export function sanitizeOutboxDeliveryFailureBatch(
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

export function sanitizeOutboxDeliveryFailure(value: unknown, context: string, requireEvent: boolean) {
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

export function sanitizeOutboxEventIdentity(value: unknown, context: string): OutboxEventIdentity {
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
