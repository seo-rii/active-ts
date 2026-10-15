# Datastore bulk failure recovery

Non-atomic `bulk.upsertMany()` and `bulk.deleteMany()` validate the complete
input before sending mutations, then send consecutive chunks. Chunk size is
bounded by both `chunkSize` and the defensive request byte budget. A failed
request stops the operation; active-ts does not retry it or send later chunks.

A non-atomic mutation failure throws `DatastoreBulkMutationError`, exported from
`active-ts/adapters/store/datastore`. It retains the original provider error as
`cause` and reports the original input positions:

| Field | Meaning |
| --- | --- |
| `operation` | `upsertMany` or `deleteMany` |
| `totalCount` | Number of validated input entries |
| `completedCount` | Entries in earlier chunks with confirmed successful responses |
| `completedRange` | Those confirmed input positions |
| `failedRange` | Input positions sent in the failed request |
| `notAttemptedRange` | Remaining positions that active-ts did not send |
| `failedBatchOutcome` | Always `unknown`; some failed-request mutations may have committed |

Each range is immutable and uses zero-based `startIndex` inclusive and
`endIndexExclusive` exclusive, so it can be passed to `entries.slice()`.
For five inputs, a chunk size of two, and a failure in the second request,
the ranges are `[0, 2)`, `[2, 4)`, and `[4, 5)` respectively.

```ts doc-test=fragment
import { DatastoreBulkMutationError } from 'active-ts/adapters/store/datastore';

try {
	await store.bulk.upsertMany(meta, entries, { chunkSize: 100 });
} catch (error) {
	if (!(error instanceof DatastoreBulkMutationError)) throw error;
	const uncertainEntries = entries.slice(
		error.failedRange.startIndex,
		error.failedRange.endIndexExclusive
	);
	const unsentEntries = entries.slice(
		error.notAttemptedRange.startIndex,
		error.notAttemptedRange.endIndexExclusive
	);
	await recordRecoveryPlan({ uncertainEntries, unsentEntries, cause: error.cause });
}
```

Reconcile uncertain entries using application receipts or original-store reads
before deciding what to retry. The exception does not imply that its failed
chunk rolled back. It also does not measure database work or billable RPCs
performed internally by an SDK.

Preflight validation and configuration errors retain their original error
types, with no mutations sent. `{ atomic: true }` retains the transaction error
contract; it does not use the non-atomic progress exception. Keep transaction
outcome handling separate from these confirmed-chunk counts.

These are low-level adapter methods. Model hooks, cache invalidation, outbox
creation, and search synchronization remain the caller's responsibility.
