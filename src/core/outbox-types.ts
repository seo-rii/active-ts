// Outbox public contracts and internal delivery state types.
import { ActiveContext } from './context.js';
import type { DatastoreKey, EntityId, ModelConstructor, SearchAdapter } from './types.js';

export type OutboxOperation = 'create' | 'update' | 'delete';

export type OutboxEvent = {
	id: string;
	model: string;
	modelId?: EntityId;
	modelIdentity?: string;
	modelDatastoreAncestor?: DatastoreKey;
	modelDatastoreProjectId?: string;
	modelDatastoreScope?: string;
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
	/** Returns a durable per-document fence, or undefined when the event lease is no longer current. */
	reserveSearchRevision?: (event: OutboxEvent, documentIdentity?: string) => Promise<number | undefined>;
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

export type StoreOutboxAdapterOptions = {
	context?: ActiveContext;
	store?: string;
	modelName?: string;
	/** Physical model used for persistent per-search-document fencing counters. */
	revisionModelName?: string;
};

export type StoreOutboxSchemaApplyOptions = {
	mode?: 'safe';
};

export type OutboxDeliveryIdentitySnapshot = {
	identity: OutboxEventIdentity;
	releaseSnapshot?: OutboxEvent;
	orderCheckKeys: string[];
	orderBlockKeys: string[];
	deliveryAttempts: number;
};

export type OutboxPluginOptions = {
	outbox: OutboxAdapter;
	includeData?: boolean;
	id?: () => string;
	allowUnsafeTransactionDeferredAppend?: boolean;
};

export type SearchSyncWorkerSharedOptions = {
	search: SearchAdapter;
	models: ModelConstructor[];
	adapter?: string;
	batchSize?: number;
	maxAttempts?: number;
	retryDelayMs?: number | ((attempt: number) => number | Promise<number>);
	deadLetter?: (failures: OutboxDeliveryFailure[]) => Promise<void>;
	allowUnsafeDrainFallback?: boolean;
	allowUnsafeIdentityOnlyDatastoreDelete?: boolean;
	allowUnsafeUnfencedSearchWrites?: boolean;
};

export type SearchSyncWorkerContextOption<TOutbox extends OutboxAdapter> =
	TOutbox extends { lease: NonNullable<OutboxAdapter['lease']> }
		? TOutbox extends { supportsExclusiveLease: () => false | Promise<false> }
			? { context?: ActiveContext }
			: { context: ActiveContext }
		: { context?: ActiveContext };

export type SearchSyncWorkerOptions<TOutbox extends OutboxAdapter = OutboxAdapter> =
	SearchSyncWorkerSharedOptions &
	{ outbox: TOutbox } &
	SearchSyncWorkerContextOption<NoInfer<TOutbox>>;

export type PendingSearchSyncDeferredEvent = {
	index: number;
	value: unknown;
	identity: OutboxDeliveryIdentitySnapshot;
};

export type PendingSearchSyncFailure = PendingSearchSyncDeferredEvent & {
	event?: OutboxEvent;
	error: unknown;
};

export type SearchSyncAdapterRoute = {
	name: string;
	indexKind: string;
	adapter: SearchAdapter;
};

export type SearchSyncMutation =
	| { operation: 'index'; identity: string | undefined; data: Record<string, any> }
	| { operation: 'delete'; identity: string | undefined };

export type OutboxDrainRecoverySnapshot =
	| { captured: true; value: unknown }
	| { captured: false; error?: unknown };
