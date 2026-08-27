# Extension Points

active-ts keeps extension behavior outside the core model API. The main
extension points are adapter middleware, field codecs, query planning,
transactions, outbox events, scopes, and schema migration snapshots.

## Adapter Middleware

Middleware wraps store, cache, or search adapters at the SDK boundary. Use it for
retry, timeout, tracing, tenant checks, metrics, circuit breaking, or adapter
auditing.

```ts doc-test=fragment
const store = createStoreMiddlewareAdapter(postgres, [
	async (ctx, next) => {
		trace.start(`store.${ctx.operation}`, { model: ctx.model.name });
		try {
			return await next();
		} finally {
			trace.end();
		}
	}
]);

const cache = createCacheMiddlewareAdapter(redis, [cacheMetrics()]);
const search = createSearchMiddlewareAdapter(elasticsearch, [searchMetrics()]);
```

## Field Codecs

Field codecs transform specific fields when data crosses the store boundary.
They are useful for PII encryption, custom scalar serialization, and legacy data
formats.

```ts doc-test=fragment
defineModel<UserData>({ name: 'user' })
	.id('id')
	.fieldCodec('private.email', {
		name: 'email-encryption',
		encode: (value) => encrypt(String(value)),
		decode: (value) => decrypt(String(value))
	})
	.attach(User);
```

Writes validate first, then encode before the store call. Reads decode before
read validation and model instantiation. Codec-backed filters require
`encodeQuery`; equality-style filters are the default, while prefix, range, and
containment operators require an explicit `queryOperators` opt-in and receive the
operator through `context.operator`.

## Query Scopes

Scopes are named query filters attached to model metadata. They are a good fit
for tenant filtering, soft delete, visibility rules, and list-level policy.

```ts doc-test=fragment
defineModel<DocumentData>({ name: 'document' })
	.scope('visibleTo', ({ viewer }) => ({
		tenantId: (viewer as User).tenantId,
		deletedAt: null
	}))
	.attach(Document);

await Document.scope('visibleTo', currentUser).load();
```

Instance policies still handle per-row checks through `model.can(...)`.

## Query Planner

The query planner can route list queries, aggregates, and search requests to
specific adapters.

```ts doc-test=fragment
const context = createActiveTs({
	stores: { primary, replica },
	search: { algolia, elasticsearch },
	queryPlanner: {
		routeQuery: ({ plan }) => (plan.native?.adapter ? undefined : 'replica'),
		routeAggregate: () => 'primary',
		schemaSearchAdapters: ['algolia', 'elasticsearch'],
		routeSearch: ({ query }) => (query.length < 3 ? 'algolia' : 'elasticsearch')
	}
});
```

Planner routes are adapter names. Returning `undefined` keeps the normal model
or builder-selected adapter. When `routeSearch` can choose different adapters
for different queries, set `schemaSearchAdapters` to the exact candidate
adapters that need schema planning and outbox search sync.

## Transactions

`context.transaction()` runs a unit of work against a transactional store when
the store adapter supports `transaction()`. The memory store rolls back by
snapshotting its collections, which keeps tests deterministic.

```ts doc-test=fragment
await context.transaction(async (tx) => {
	await Account.create(accountData, tx);
	await AuditLog.create(logData, tx);
});
```

Models also expose a thin helper that opens the transaction on that model's
store:

```ts doc-test=fragment
await Account.transaction(async (tx) => {
	await Account.create(accountData, tx);
});
```

Model bulk writes open that same model-scoped transaction automatically. They
snapshot caller input, prepare every row through write validation, field codecs,
and before-write hooks before issuing the first mutation. After-write hooks run
inside the transaction, while cache, search, and outbox work is staged through
the same transaction coordination:

```ts doc-test=fragment
const bulkResults = await Account.upsertMany([
	primaryAccountData,
	secondaryAccountData
]);

for (const result of bulkResults) {
	console.log(result.operation, result.item.id); // "create" or "update"
}

await Account.deleteMany([primaryAccountData.id, secondaryAccountData.id]);
```

`createMany()` returns the created models. `upsertMany()` requires an id on
every input row, creates missing rows, and applies each input as an update patch
to an existing row so omitted fields and optimistic-lock versions are retained.
Its result order matches input order. `deleteMany()` follows static `delete()`
semantics: missing rows are cache-invalidated but do not run delete hooks.
Duplicate typed ids are rejected; numeric `1` and string `"1"` remain distinct.
Ancestor-backed Datastore rows can use `createMany()` because each complete row
can resolve its physical key. `upsertMany()` and id-only `deleteMany()` reject
those models, as their ids do not identify one physical descendant without an
ancestor-aware query.

Non-empty model bulk calls require transaction support and are always
all-or-nothing, subject to the backing store's transaction size and entity-group
limits. Inside an existing transaction they reuse the ambient boundary. Wrap
them in `Model.transaction()` when adapter-specific isolation, timeout, or native
options are needed. Once bulk transaction work starts, a failure marks an ambient
transaction rollback-only even when callback code catches the operation error.
To recover and continue the parent transaction, isolate the call in an explicit
`join: "savepoint"` boundary on an adapter that supports savepoints. For
deliberately non-atomic administrative imports, restore jobs, and chunked
maintenance writes, use the
Datastore adapter's low-level `bulk.upsertMany()` / `bulk.deleteMany()` API
instead; that API accepts encoded store data and intentionally bypasses model
validation, hooks, caches, search, and outbox work.

Pass transaction options when the backing adapter can honor them:

```ts doc-test=fragment
await context.transaction(
	async (tx) => {
		await Account.create(accountData, tx);
	},
	{ isolation: 'serializable', readOnly: false, timeoutMs: 5_000 }
);
```

When the transaction runner observes callback settlement, built-in adapters
close its store handle to new work and wait for store operations that were
already started before committing or rolling back. Microtasks queued by the
callback before it returns run before that settlement reaction and remain in
the callback lifetime; later work is rejected. This prevents an accidentally
unreturned write Promise from being acknowledged after the commit boundary.
An operation failure that settles while the callback is still running remains
registered until callback code handles its rejection through `await` or a
rejection handler whose result fulfills. `finally()` and handlers that throw or
return a rejected Promise preserve the failure. If the callback returns normally
without handling it, the transaction rolls back instead of partially committing
other writes. Callers should still `await` each operation when later callback
code depends on its result or needs to handle its error locally.

Context transactions apply the same rule to complete model writes, queries,
aggregates, searches, lazy relation loads, and context-bound adapter calls. The
tracked lifetime includes validation, adapter access, cache/outbox staging,
relation loading, and hooks. An in-flight operation may start nested work from
its own async chain while the transaction drains, but unrelated work started
after callback settlement is rejected. The transaction waits until nested work
also settles before allowing the adapter to commit. Promise continuations
attached before the callback settles are tracked work too, even when their
derived Promise is discarded. Their callbacks retain transaction lineage, and
an ignored continuation failure rolls back the transaction. A continuation
attached after callback settlement may still observe the original Promise, but
it cannot start transaction work.

Native Promise combinators assimilate transaction operation Promises through
internal rejection callbacks. JavaScript does not expose whether the resulting
native Promise is awaited or discarded. Await or return those wrappers from the
transaction callback, or register a deliberately detached wrapper with
`tx.track()` so its outer result remains part of the transaction drain:

```ts doc-test=fragment
void tx.track(() => Promise.all([
	Account.create(primaryAccountData, tx),
	Account.create(secondaryAccountData, tx)
]));
```

Pass a factory, not an already-started Promise, so wrapper construction and all
nested operations inherit the tracked lineage. The low-level equivalent for a
store transaction callback is
`trackStoreTransactionWork(txStore, () => Promise.all([...]))`. Both helpers
reject outside a transaction-scoped handle and retain an ignored rejecting
wrapper as a rollback cause. `Promise.allSettled()` intentionally fulfills even
when members reject; inspect its statuses and throw from the tracked factory
when a rejected member must roll back the transaction.

Nested transactions fail by default. Use `join: 'reuse'` when a helper should
share the current boundary, or `join: 'savepoint'` when its writes and rollback
hooks need an isolated child boundary:

```ts doc-test=fragment
await context.transaction(async (tx) => {
	await Account.create(primaryAccountData, tx);
	try {
		await tx.transaction(async (child) => {
			await Account.create(optionalAccountData, child);
		}, { join: 'savepoint' });
	} catch (error) {
		// The outer transaction remains usable after a definitive savepoint rollback.
	}
});
```

A successful savepoint merges its cache invalidations, outbox work,
`afterCommit`, and `afterRollback` tasks into the parent transaction. A failed
savepoint discards commit work, runs its rollback tasks after the physical child
rollback, and makes models retained from that child stale. Savepoint contexts
and low-level child store handles close when their callbacks finish. Isolation,
read-only mode, timeout, native options, and store routing cannot change inside
an active transaction.

Low-level transaction callback adapters expose `txStore.savepoint(fn)` when
`txStore.capabilities.savepoint === true`. Savepoint callbacks receive their own
lifetime-guarded child adapter. Active-ts drains ignored child work and orders
parent operations started after the savepoint behind its release or rollback;
store middleware preserves this boundary.

Built-in store adapters support different transaction options and savepoints:

| Adapter | Transaction support | Savepoints | Supported options | Native behavior |
| --- | --- | --- | --- | --- |
| Memory | Yes | Yes | `readOnly` | Rejects `isolation`, `timeoutMs`, and `native`; intended for deterministic tests. |
| PostgreSQL | Yes | Yes | `isolation`, `readOnly`, `timeoutMs` | Rejects transaction `native`; native SQL is still available through query builders outside read-only transaction guards. |
| MongoDB | When the client exposes `startSession()` | No | `readOnly`, `timeoutMs`, plus `native.readConcern`, `native.writeConcern`, `native.readPreference`, and `native.maxCommitTimeMS` | Requires a replica set or sharded cluster; transaction handles reject native query payloads and serialize portable driver operations on one session. |
| Datastore | When the SDK client exposes `transaction()` | No | `readOnly`, plus `native.gaxOptions`, `native.commitGaxOptions`, and `native.rollbackGaxOptions` | Write transactions allow native query callbacks before buffered writes; read-only transactions reject native callbacks. |
| Firestore | Yes | No | `readOnly`, plus `native.maxAttempts`, `native.readOnly`, and `native.readTime` | Transaction queries reject native function payloads; Firestore requires all unbuffered reads before writes. Queries wait for earlier pending mutations before enforcing that boundary. |

PostgreSQL marks a native transaction aborted after a SQL statement error.
Inside `txStore.savepoint()` or `join: 'savepoint'`, active-ts assigns statement
failures to the child scope and recovers with `ROLLBACK TO SAVEPOINT` before the
parent continues. Outside a savepoint, active-ts rejects and rolls back even
when callback code caught the mapped adapter error. A failed savepoint recovery
also poisons the parent so it cannot commit. Errors rejected during active-ts
preflight validation, before SQL execution, remain recoverable inside the
callback. Native
transaction query handles are Promise-only and reject `pg` callback overloads;
this includes callbacks embedded in query configuration objects. Pass SQL text
or a plain `pg` query configuration object rather than a `pg.Query` instance.
Active-ts also waits for native SQL started before the transaction callback
settles and retains ignored preflight failures, including rejected callback
overloads, query objects, and transaction-control SQL. It closes retained native
query handles afterward, rejects transaction-control SQL such as
`PREPARE TRANSACTION`, and verifies that PostgreSQL reports `COMMIT` rather than
an implicit `ROLLBACK`. A failed or malformed commit response is reported as an
unknown outcome without running rollback callbacks, and the indeterminate
PostgreSQL client is discarded rather than returned to the connection pool.
Await each `query()` result when later callback code depends on it or needs to
handle its error locally.

MongoDB uses `startSession()` and the driver's Core transaction API. It invokes
the application callback once and does not use `withTransaction()`, so active-ts
never retries user hooks or model work implicitly. It also serializes portable
operations because the MongoDB driver does not support parallel commands in one
transaction. A callback or tracked operation failure is rolled back with
`abortTransaction()`. The MongoDB 7 driver can internally retry retryable commit
commands and one retryable abort command, but active-ts never repeats the
callback. A commit rejection is indeterminate only when it carries
`UnknownTransactionCommitResult`; active-ts exposes that case as
`ActiveTsUnknownTransactionOutcomeError` with `outcome === "unknown"`,
`phase === "commit"`, and the driver error in `cause`. A
`TransientTransactionError` or other definitive commit failure runs rollback
semantics. The driver normally suppresses abort command errors; a rejecting
injected session is exposed with `phase === "abort"`. Unknown outcomes suppress
both transaction-finalization hook groups. A session cleanup failure after a
successful commit is reported as `ActiveTsCommittedTransactionError` with the
callback result. MongoDB transaction deployments must be replica sets or
sharded clusters.

Firestore likewise reports a transport failure after its transaction callback
completes as an unknown commit outcome. Neither `afterCommit` nor
`afterRollback` tasks run because the durable result cannot be proven. Explicit
Firestore aborts and first-attempt conflicts remain definitive rollbacks. If the
Firestore SDK asks to rerun a callback after a completed attempt that registered
a write, active-ts stops before rerunning user code and reports the write outcome
as unknown; a lost successful response could otherwise repeat hooks and outbox
work or become a false duplicate conflict on the retry.

Datastore mode databases using `OPTIMISTIC_WITH_ENTITY_GROUPS` must run only
ancestor queries inside transactions. Set `requireAncestorTransactionQueries: true`
on `createDatastoreStoreAdapter()` for those projects so portable transaction
`query()` and `aggregate()` calls fail before the SDK sees an unscoped query.
Leave it off for modern Datastore concurrency modes that allow broader
transaction queries.

Datastore native transaction payloads receive a read-only transaction client.
Its Promise-returning `get()`, `runQuery()`, and `runAggregationQuery()` calls
are transaction work: active-ts drains them even when the payload does not
return their Promises, rolls back on ignored failures, and rejects retained read
execution after the callback closes. Query and aggregation builder `run()` calls
use the same tracked transaction client, and their facades do not expose the raw
SDK scope through ordinary or reflective property access. `runStream()` and
callback overloads are not supported; use and await the returned Promises when
later payload logic depends on them. Pure key and builder construction remains
available, but a retained builder cannot execute after transaction closure.

Datastore exports `DatastoreStoreTransactionOptions`,
`DatastoreTransactionOptions`, and `DatastoreModelTransactionOptions`, plus
`datastoreStoreTransactionOptions()`, `datastoreTransactionOptions()`, and
`datastoreModelTransactionOptions()`, from `active-ts/adapters/store/datastore`.
Use the helper functions around inline options passed to generic APIs such as
`context.transaction()` or `Model.transaction()` when you want TypeScript to
check Datastore-specific `native` keys at the call site. Firestore exposes the
matching native option shape as `FirestoreTransactionNativeOptions`.

Adapter instances passed into `createActiveTs()` are raw backend objects. They
remain useful for setup and backend-specific maintenance, but they do not
participate in ambient active-ts transaction guards when called directly. Helper
APIs that accept adapters should accept the context-bound handles returned by
`context.store()`, `context.cache()`, and `context.searchAdapter()` instead.
Store adapters passed to `context.store(...).transaction()` callbacks are also
context-bound and keep the transaction lifetime guard; adapters passed to raw
store `transaction()` callbacks remain raw.
Use `isContextBoundStoreAdapter()`, `isContextBoundCacheAdapter()`,
`isContextBoundSearchAdapter()`, or the matching `assertContextBound*` helpers
to reject raw adapters at extension boundaries. The cache guard also recognizes
first-party cache middleware wrappers that preserve the source handle chain.

The public transaction helpers are standalone TypeScript APIs:

```ts doc-test=typecheck
import { MemoryStoreAdapter, Model, createActiveTs, defineModel } from 'active-ts';

type TransactionAccountData = {
	id: number;
	balance: number;
};

class TransactionAccount extends Model<TransactionAccountData> {}

defineModel<TransactionAccountData>({ name: 'transaction_account' })
	.id('id')
	.validate((input) => input as TransactionAccountData)
	.attach(TransactionAccount);

const context = createActiveTs({
	stores: { default: new MemoryStoreAdapter() }
});
const Account = TransactionAccount.use(context) as unknown as typeof TransactionAccount;

await context.transaction(async (tx) => {
	await Account.create({ id: 1, balance: 100 }, tx);
}, { readOnly: false });

await Account.transaction(async (tx) => {
	await Account.create({ id: 2, balance: 50 }, tx);
}, { join: 'error' });
```

Nested transactions fail by default. Use `join: 'reuse'` to share the active
transaction deliberately or `join: 'savepoint'` for an isolated child boundary
on Memory and PostgreSQL. Datastore and Firestore reject savepoint joins because
their transaction APIs do not expose portable savepoints.

Extensions can register deferred work:

```ts doc-test=fragment
await context.afterCommit(() => publishMessage());
await context.afterRollback(() => metrics.increment('rollback'));
```

`afterCommit` tasks run after the store commit. If one fails, active-ts still
runs the remaining tasks and then rejects with
`ActiveTsCommittedTransactionError`. Its `committed` property is `true`,
`result` preserves the transaction callback result, and `cause` is an
`AggregateError` containing every failed task. The committed store write is not
rolled back. `afterRollback` task failures are logged without hiding the
original rollback reason.
External search adapters cannot be read inside transactions because their
indexes do not include uncommitted writes. Native search adapters are rebound to
the transaction-scoped store and remain available; run other search reads after
commit, typically after outbox-driven search sync has caught up.

## Outbox

The outbox plugin records model changes after commit. This is safer than
publishing search indexing, webhooks, or pub/sub events directly inside model
hooks.

```ts doc-test=fragment
const outbox = new StoreOutboxAdapter({ store: 'default' });

const context = createActiveTs({
	stores: { default: store },
	plugins: [createOutboxPlugin({ outbox, includeData: true })]
});
```

Production apps should implement `OutboxAdapter` with a durable table or
collection and have workers deliver events from it.

For transactional durability, use an outbox adapter that implements
`appendTransactional(context, event)`. `createOutboxPlugin()` writes through that
method inside the active store transaction, so an outbox write failure rolls back
the domain write instead of becoming a post-commit side-effect failure.
`StoreOutboxAdapter` is the built-in store-backed implementation; construct it
with the same transaction store used by your models. When installed through
`createOutboxPlugin()`, the adapter binds to the active context during plugin
setup. You can also pass `context` explicitly when constructing the adapter for
manual scripts. For Datastore and Firestore transactions, active-ts rejects
deferred post-commit appends unless the outbox adapter implements
`appendTransactional()`; commit failures can leave the transaction outcome
unknown. Pass
`allowUnsafeTransactionDeferredAppend: true` only for low-level integrations that
explicitly accept the risk of missing outbox events after commit-unknown errors.

Search sync can deliver outbox events into a search adapter:

```ts doc-test=fragment
await runSearchSyncWorker({
	outbox,
	search: elasticsearch,
	models: [Account, Post],
	context,
	batchSize: 100
});
```

Pass the active context when available so the worker uses each model's resolved
metadata, including custom id fields, field codecs, and declared search indexes.
Use `batchSize` to bound each worker tick. The worker passes `{ limit:
batchSize }` into `lease()` or `drain()`, and the built-in memory/store outbox
adapters honor that limit directly. Custom adapters should do the same; the
worker also releases or requeues overflow defensively if an adapter returns more
than the requested limit.

For Datastore models with ancestor metadata, outbox search sync keeps the public
model id unchanged but carries a bounded per-entity `modelIdentity` for the
backend search document key. This lets two children with the same id under
different ancestors index and delete independently. When an ancestor event omits
payload data, the worker reloads the row with an ancestor-scoped query instead
of a direct id read. Delete events must carry either `modelDatastoreAncestor` or
payload data that can derive the ancestor. Legacy identity-only Datastore delete
events can be processed with `allowUnsafeIdentityOnlyDatastoreDelete: true`, but
that option trusts the stored `modelIdentity` and should only be used while
migrating old queues.

`runSearchSyncWorker()` supports two outbox delivery contracts:

- `lease()/ack()/isLeaseCurrent()` is preferred for durable adapters. `lease()`
  returns visible events without deleting them, `isLeaseCurrent(event)` confirms
  the worker still owns the lease before delivery, and `ack(events)` removes
  only events that were indexed successfully. `StoreOutboxAdapter` implements
  this contract, so failed deliveries remain queued for retry. Its built-in
  lease path requires the backing store to support optimistic locking so
  concurrent workers cannot claim the same rows. When the backing store is
  transactional but does not support optimistic locking, such as Datastore, the
  search worker fails closed by default. Pass `allowUnsafeDrainFallback: true`
  only when the deployment accepts the crash-loss risk of using the adapter's
  `drain()/requeue()` path.
- `drain()/requeue()` is supported for legacy/custom adapters. If indexing
  fails after a drain, the worker calls `requeue(events)` with the failed and
  undelivered events so a later run can retry them in order. Search sync rejects
  drain-only adapters because appending failed events at the tail can reorder
  older writes behind newer events.

Search indexing should still be implemented idempotently because a backend
failure can happen after a partial remote write. Custom `drain()`
implementations should be atomic: if `drain()` rejects, the same events should
remain visible for a later retry. When an outbox also exposes `list()`, the
worker takes a best-effort pre-drain snapshot and requeues events that
disappeared after a failed drain. This recovery is a safety net for drain
failures, not a replacement for durable outbox storage.

## Soft Delete

The soft-delete plugin adds a default `deletedAt = null` query/aggregate filter
for selected models. Use `softDelete()` to mark a row instead of hard-deleting
it:

```ts doc-test=fragment
const context = createActiveTs({
	stores: { default: store },
	plugins: [createSoftDeletePlugin({ models: ['account'] })]
});

await softDelete(Account, 1, context);
await Account.onlyDeleted().load();
await Account.withDeleted().load();
await restore(Account, 1, context);
```

`onlyDeleted()` and `withDeleted()` are query helpers. `restore()` clears the
configured soft-delete field and saves the row.

The default live-row filter treats missing `deletedAt` as null. Stores such as
Firestore and Datastore do not guarantee that backend null filters match
missing fields, so the plugin fails fast on those adapters unless you have
backfilled/materialized `deletedAt: null` on all live rows and opt in with
`createSoftDeletePlugin({ materializedNulls: true })`.

## Optimistic Locking

Models with a numeric `version` field use optimistic locking in `save()`. The
current stored version must match the instance version; successful saves
increment the field.

```ts doc-test=fragment
const record = await Document.find(1).load();
record.data.title = 'Updated';
await record.save();
```

If another writer already advanced `version`, `save()` throws an
`ActiveTsConflictError`.

Adapters that support `capabilities.optimisticLock` perform this as a conditional
write. Adapters that cannot provide an atomic compare-and-set must declare
`optimisticLock: false`, and active-ts fails fast instead of presenting a
best-effort lock.

## Function Cache Singleflight

Function caches coalesce concurrent misses for the same key by default. Set
`singleFlight: false` to opt out.

```ts doc-test=fragment
const cache = createFunctionCache({
	prefix: 'profile',
	namespace: ({ tenantId }) => tenantId,
	ttl: 60,
	staleWhileRevalidate: 30,
	factory: buildProfile
});
```

Entity cache keys can also be namespaced at the context level:

```ts doc-test=fragment
createActiveTs({
	stores,
	caches,
	cacheKey: ({ baseKey }) => `${tenantId}:${baseKey}`
});
```

## Validation Adapters

Validation helpers normalize common parser APIs into active-ts validators:

```ts doc-test=fragment
defineModel<UserData>({ name: 'user' })
	.validate(fromZod(userSchema))
	.attach(User);
```

Available helpers include `fromTypia`, `fromZod`, `fromValibot`, and
`fromArkType`. If your ArkType integration returns a custom error object, pass
`fromArkType(schema, { isProblem })` so active-ts can distinguish parser
failures from valid domain data that happens to contain a `problems` field.

## Schema Migration Snapshots

`schemaMigration()` captures adapter schema plans without applying them. It is a
small migration primitive for CI drift checks and generated migration files.

```ts doc-test=fragment
const migration = await context.schemaMigration([User, Post], 'init');

if (!migration.empty) {
	console.log(migration.summary);
}
```

Use `schemaApply()` only when you want the active adapters to apply safe,
non-destructive changes.

Some backends expose declarative plans that still need vendor tooling. For
example, Firestore, Datastore, Algolia, and Elasticsearch plans can return
`status: "manual"` with a note explaining the deployment step.

The package also ships a small CLI:

```sh
active-ts schema diff --config ./active-ts.config.js
active-ts schema generate --config ./active-ts.config.js --name add-user-index
active-ts schema apply --config ./active-ts.config.js
```

The config module must export `{ context, models }`. It may also export a
`dispose()` or `close()` function, either at the top level or from the default
export; the CLI awaits it after schema commands succeed or fail so adapters can
close pools, emulator connections, or other process resources.
