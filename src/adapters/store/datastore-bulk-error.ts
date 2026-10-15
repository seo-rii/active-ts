import { ActiveTsError, safeErrorMessage } from '../../core/errors.js';

/** Zero-based input indices in the half-open interval [startIndex, endIndexExclusive). */
export type DatastoreBulkMutationRange = {
	readonly startIndex: number;
	readonly endIndexExclusive: number;
};

/** A failed non-atomic batch may have committed any subset of its mutations. */
export class DatastoreBulkMutationError extends ActiveTsError {
	readonly failedBatchOutcome = 'unknown' as const;
	readonly completedRange: DatastoreBulkMutationRange;
	readonly failedRange: DatastoreBulkMutationRange;
	readonly notAttemptedRange: DatastoreBulkMutationRange;

	constructor(
		readonly operation: 'upsertMany' | 'deleteMany',
		readonly totalCount: number,
		readonly completedCount: number,
		failedBatchEndIndex: number,
		readonly cause: unknown
	) {
		super(
			`Datastore bulk ${operation} failed after ${completedCount} confirmed entries; ` +
			`entries [${completedCount}, ${failedBatchEndIndex}) have an unknown outcome: ${safeErrorMessage(cause)}`
		);
		this.completedRange = Object.freeze({ startIndex: 0, endIndexExclusive: completedCount });
		this.failedRange = Object.freeze({ startIndex: completedCount, endIndexExclusive: failedBatchEndIndex });
		this.notAttemptedRange = Object.freeze({ startIndex: failedBatchEndIndex, endIndexExclusive: totalCount });
	}
}
