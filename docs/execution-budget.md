# Request execution budgets

Use one absolute deadline and request signal across adapter calls and application
retry attempts. `createExecutionBudget()` performs cooperative checks; it does
not start retries or cancel an SDK request by itself.

```ts
import {
  createActiveTs,
  createExecutionBudget,
  createStoreExecutionBudgetAdapter,
  type StoreAdapter
} from 'active-ts';

function requestContext(request: Request, sharedStore: StoreAdapter) {
  const budget = createExecutionBudget({
    signal: request.signal,
    deadline: Date.now() + 2_000
  });
  const context = createActiveTs({
    stores: {
      default: createStoreExecutionBudgetAdapter(sharedStore, budget)
    }
  });
  return { context, budget };
}
```

Bind models with `Record.use(context)` for each request. Reuse the underlying SDK client where
the runtime permits it; keep the budget, context, and transaction request-local.
The wrapper preserves store identity, cache scope, Datastore identity metadata,
capabilities, schema hooks, and transaction lifecycle guards.

## What the wrapper checks

Every store read, write, aggregate, schema call, transaction, and savepoint checks
the budget before dispatch. Each transaction callback invocation checks again,
including callbacks repeated by a provider. Before returning callback success
to the provider, the wrapper drains tracked operations and checks the budget;
an expired callback throws so the provider can roll it back. The same budget is
inherited by transaction and savepoint store handles.

The wrapper waits for an already-dispatched operation's actual result. A write
or commit confirmed after cancellation still resolves successfully. A provider
error, including an unknown commit outcome, passes through unchanged. A budget
failure can follow earlier successful writes, so it describes the rejected
dispatch, not the commit status of an entire request. Store transactions remain
subject to the provider's rollback guarantees and errors.

The wrapper covers store dispatches only. Cached reads, search calls, HTTP calls,
and application work need their own budget checks. This is especially relevant
when a model read can be served entirely from cache. No adapter capability for
native I/O cancellation is added or implied.

## Connecting a provider bridge

`budget.run()` checks once and passes a frozen snapshot containing the original
`signal`, absolute `deadline`, and `remainingMs`. A custom SDK bridge can map
these to the provider's documented cancellation and timeout options:

```ts
const result = await budget.run(async ({ signal, remainingMs }) => {
  // providerRead is application/adapter bridge code, not an active-ts API.
  return await providerRead({ signal, timeoutMs: remainingMs });
});
```

`deadline` is a non-negative safe integer Unix timestamp in milliseconds;
`remainingMs` is sampled at dispatch and is undefined without a deadline. The
signal is not replaced with a synthetic timeout signal. Recompute the remaining
budget for every attempt. The supplied store adapters do not automatically map
this state into SDK options. Provider cancellation support must be verified for
the specific SDK, transport, and operation before a bridge advertises it.

`run()` has no `Promise.race` timeout and preserves in-flight results. Even
native transport cancellation or a provider timeout does not prove that the
server cancelled a write or commit. Resolve uncertain outcomes with a durable
application receipt before repeating a business operation.

## Retry ownership and backoff

Choose one retry owner for each operation. For example, let the provider own
transaction conflict retries, and let the application own retries of explicitly
idempotent reads. Configure SDK and UI retries accordingly; this wrapper does
not disable or reconfigure them. A provider may still perform internal attempts
inside one dispatched RPC. Use its deadline/retry controls to bound those attempts.

For an application-owned retry, call `budget.run()` for every attempt and
`await budget.backoff(delayMs)` between attempts. Backoff rejects immediately
when the full delay cannot fit before the absolute deadline, stops when the
request signal aborts, and removes its timer/listener when settled. The next
`run()` checks again in case the event loop resumed after the deadline. Neither
method retries anything automatically.

`ActiveTsExecutionBudgetError` reports `reason: 'aborted' | 'deadline'` and
`phase: 'before-dispatch' | 'backoff'`. An aborted signal's original reason is
available as `cause`. These fields describe cooperative cancellation only;
they do not assert that prior writes were rolled back. Do not retry a confirmed
commit or an unknown commit outcome as a generic timeout failure.

## Search synchronization and reindexing

Search revision writes and durable outbox synchronization already provide the
ordering primitives: use one durable revision allocator per document identity,
preserve delete tombstones, and reject adapters lacking `revisionWrites` before
leasing revision-fenced work. See [search revision writes](adapters.md#search-adapters)
and [outbox delivery](extensions.md) for the existing contract.

Keep a search worker's delivery budget separate from the HTTP request that
created the durable event. An aborted request must not discard an event already
committed with the entity. On worker budget exhaustion, preserve the outbox
lease/retry contract rather than acknowledging unfinished work. During full
reindexing, preserve revisions and tombstones or coordinate a writer pause and
authoritative replay before cutover. A deadline does not make competing reindex
and incremental writes atomic. Search hits still require an authoritative read,
permission checks, and the application's View/DTO conversion.

The execution-budget tests use in-process memory adapters and simulated provider
callback/commit outcomes. They establish cooperative checks and result
preservation; they do not establish native cancellation in Datastore, Redis,
search SDKs, Workers, or a live service.
