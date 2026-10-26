import { ActiveTsConfigurationError } from './errors.js';
import { WEAKMAP_GET, WEAKMAP_SET } from './collection-intrinsics.js';

export const MODEL_PERSISTED_TOKEN: unique symbol = Symbol('active-ts.persisted-constructor-token') as any;
export const ACTIVE_TS_MODEL_INSTANCE: unique symbol = Symbol('active-ts.model-instance') as any;
export const MODEL_DATASTORE_WRITE_ANCESTOR: unique symbol = Symbol('active-ts.datastore-write-ancestor') as any;

const TRANSACTION_MODEL_TRACKERS = new WeakMap<object, (item: object) => void>();
const DATASTORE_HISTORICAL_READ_TIMES = new WeakMap<object, number>();

export type ModelConstructorOptions = {
	persisted?: boolean;
	[MODEL_PERSISTED_TOKEN]?: true;
};

export function setTransactionModelTracker(context: object, tracker: (item: object) => void) {
	WEAKMAP_SET.call(TRANSACTION_MODEL_TRACKERS, context, tracker);
}

export function trackTransactionModel(context: object, item: object) {
	(WEAKMAP_GET.call(TRANSACTION_MODEL_TRACKERS, context) as ((item: object) => void) | undefined)?.(item);
}

export function markDatastoreHistoricalModel(item: object, readTime: number) {
	WEAKMAP_SET.call(DATASTORE_HISTORICAL_READ_TIMES, item, readTime);
}

export function datastoreHistoricalModelReadTime(item: object) {
	return WEAKMAP_GET.call(DATASTORE_HISTORICAL_READ_TIMES, item) as number | undefined;
}

export function assertModelSnapshotRelationsAllowed(item: object) {
	const readTime = datastoreHistoricalModelReadTime(item);
	if (readTime === undefined) return;
	throw new ActiveTsConfigurationError(
		`Cannot load relations on a model loaded by readAt(${readTime}); historical relations require explicit snapshots with the same read policy.`
	);
}

const MODEL_RELATION_GENERATIONS = new WeakMap<object, number>();

export function modelRelationGeneration(item: object) {
	return (WEAKMAP_GET.call(MODEL_RELATION_GENERATIONS, item) as number | undefined) ?? 0;
}

export function invalidateModelRelations(item: object) {
	WEAKMAP_SET.call(MODEL_RELATION_GENERATIONS, item, modelRelationGeneration(item) + 1);
}
