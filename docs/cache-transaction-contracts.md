# Transaction outcomes and cache coexistence

`context.transactionResult()` reports the observed commit outcome of one root
transaction invocation. It runs the same transaction implementation as
`context.transaction()`, including provider retries and deferred hooks, and does
not introduce another retry layer. The existing throwing API is unchanged.

```ts doc-test=fragment
const outcome = await context.transactionResult(async (tx) => {
	const record = await Record.create(input, tx);
	// A StoreOutboxAdapter configured on this same store can append durably here.
	return { id: record.data.id };
});

switch (outcome.outcome) {
	case 'committed':
		// The callback result survives a cache, cleanup, or afterCommit failure.
		if ('error' in outcome) reportDeliveryFailure(outcome.error);
		return outcome.result;
	case 'not_committed':
		throw outcome.error;
	case 'unknown':
		// Reconcile an application-owned durable receipt before deciding to retry.
		return reconcileOperation(operationId, outcome.error);
}
```

| Outcome | Evidence |
| --- | --- |
| `committed` | The adapter acknowledged success, or explicitly returned `ActiveTsCommittedTransactionError`. `result` contains the callback result; `error` is present when post-commit work failed. |
| `not_committed` | active-ts rejected the request before invoking the store transaction, or the adapter confirmed rollback or a definitive commit rejection for this invocation. The original thrown value is retained in `error`. |
| `unknown` | The transaction was invoked and neither commit nor rollback was established. This includes ordinary adapter exceptions without outcome evidence. |

The evidence is local to the invocation. active-ts does not infer commit from an
arbitrary `committed` property, an exception's `cause`, or a committed error thrown
by the user callback. The same frozen error object can appear in concurrent
invocations without carrying a previous invocation's outcome. Primitive thrown
values, including `undefined`, are preserved.

The outcome API requires a root transaction. Calls through a transaction context,
or through its ambient root context during a transaction callback, return a
`not_committed` configuration error without starting nested work. A savepoint
release or `join: 'reuse'` cannot establish the enclosing transaction's commit.

Current rollback evidence is available for PostgreSQL and SQLite when their final
rollback succeeds; for Datastore when rollback succeeds or the final commit is
definitively rejected; and for Memory when failure occurs before applying the
commit or commit validation rejects a conflict. MongoDB confirms successful
abort and definitive transaction conflicts; Firestore confirms SDK-propagated
callback failures and definitive commit rejection. Other exceptions during
Memory commit application are conservatively unknown. Custom adapters may
return `unknown` for failures they cannot prove to this API. Success still
reports `committed`. An `unknown` result does not
assert that the database committed, rolled back, or stopped executing work.

Both transaction APIs run rollback tasks only after rollback is established.
For unconfirmed failures they close the transaction context, suppress both
`afterCommit` and `afterRollback`, and attempt eviction of the affected entity
cache entries. An ordinary exception after the store has committed cannot
trigger rollback compensation. Custom adapters that previously relied on every
rejection running `afterRollback` must account for this conservative behavior.

Third-party adapters can report confirmed rollback through
`ActiveTsRolledBackTransactionError`. Throw a new instance only after the adapter
has established that its transaction did not commit; retain the original error
in `cause`. active-ts trusts this explicit adapter signal and runs rollback tasks.
The error itself is preserved by both transaction APIs. A matching class thrown
by the user callback supplies no adapter evidence, and nested `cause` values are
never searched for an outcome.

```ts doc-test=fragment
try {
	return await executeTransactionCallback();
} catch (cause) {
	await confirmProviderRollback(); // Must reject if rollback cannot be established.
	throw new ActiveTsRolledBackTransactionError('Provider rollback confirmed', cause);
}
```

Transaction callbacks may execute more than once when the provider retries.
Keep external network effects outside the callback. For durable delivery, write
business data, an application receipt, and an outbox record through the same
transactional store. A volatile `afterCommit` callback alone is not durable
delivery. Operation IDs, payload digests, receipt retention, delivery retries,
and compensation across databases remain application policy.

Cache and search errors after confirmed commit do not authorize repeating the
business write. Inspect `error` on a committed result and recover only the failed
post-commit work. A `not_committed` result also does not impose a retry policy;
validation and permanent provider errors often should not be retried.

## External writers and cache migrations

Raw SDK and low-level store writes bypass model lifecycle invalidation. After a
confirmed external commit, use the model-aware invalidation API with the context
that routes to the affected physical store:

```ts doc-test=fragment
await externalWriter.commit();
await context.invalidateModelExternal(Record, id);
```

This existing API invalidates the root cache immediately, including when called
from a transaction callback. It does not wait for an unrelated ORM transaction to
commit. Built-in Memory and Redis/Valkey version fences reject cache fills that
started before invalidation. Custom caches without the complete versioned cache
contract cannot provide that cross-context guarantee. Every external writer must
use the same key scope and invalidation protocol; sharing a codec alone does not
establish cache coherence.

Use a new Redis prefix when a cache's representation or invalidation protocol
changes, for example `prefix: 'entity-cache:v2'`. Give different physical
projects, databases, and tenants different cache scopes. Viewer-specific DTO
caches also need viewer and authorization scopes chosen by the application;
the ORM's raw entity cache is not an authorization cache. Transaction and
Datastore historical reads bypass ordinary entity cache hits to prevent mixing
current state into the requested read context.

The verification for this contract uses unit tests with Memory and injected
Datastore clients. It does not establish emulator, real-service, or Workers
behavior for an untested SDK combination.
