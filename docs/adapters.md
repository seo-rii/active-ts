# Adapters

Adapters isolate active-ts from backend SDKs. Applications register adapters in
an `ActiveContext`; models select adapters by metadata or by context defaults.

## Store Adapters

| Adapter | Package import | Peer dependency | Notes |
| --- | --- | --- | --- |
| Memory | `active-ts/adapters/store/memory` | none | deterministic tests and local examples |
| Datastore | `active-ts/adapters/store/datastore` | `@google-cloud/datastore` | preserves Datastore key metadata as a symbol; uses Datastore aggregation queries when available |
| Firestore | `active-ts/adapters/store/firestore` | `@google-cloud/firestore` | validates paths; optimizes `count`, `sum`, and `avg` |
| MongoDB | `active-ts/adapters/store/mongodb` | `mongodb` | validates names; pipelines count/sum/avg |
| PostgreSQL | `active-ts/adapters/store/postgresql` | `pg` | stores row data in JSONB; optimizes aggregates with SQL |

PostgreSQL model and index identifiers still use active-ts portable schema
identifier rules. The adapter-level `schema` option is a PostgreSQL schema
identifier and is SQL-quoted by the adapter, so it may use PostgreSQL quoted
identifier syntax as long as it is non-empty, has no null bytes, and fits the
PostgreSQL identifier byte limit.

Supported peer ranges:

- `pg`: `^8.0.0`
- `mongodb`: `^7.0.0`
- `@google-cloud/firestore`: `^8.0.0`
- `@google-cloud/datastore`: `^10.0.0`

Example:

```ts doc-test=typecheck
import { createMongoStoreAdapter } from 'active-ts/adapters/store/mongodb';

const store = await createMongoStoreAdapter({
	url: process.env.MONGODB_URL,
	dbName: 'app'
});
```

Datastore models can declare ancestor key and unindexed-field metadata:

```ts doc-test=typecheck
import { Model, createActiveTs, datastoreKey, defineModel, type ActiveContext } from 'active-ts';
import {
	createDatastoreIndexYaml,
	createDatastoreStoreAdapter
} from 'active-ts/adapters/store/datastore';

type CommentData = {
	id: number;
	postId: number;
	body: string;
	updatedAt: number;
	moderation: {
		state: string;
		reviewedAt: number;
	};
};

class Comment extends Model<CommentData> {}

const datastore = await createDatastoreStoreAdapter({
	namespace: process.env.DATASTORE_NAMESPACE,
	datastoreOptions: { projectId: process.env.GOOGLE_CLOUD_PROJECT }
});
const context: ActiveContext = createActiveTs({
	defaultStore: 'datastore',
	stores: { datastore }
});

defineModel<CommentData>({ name: 'comment', store: 'datastore' })
	.id('id')
	.validate((input) => input as CommentData)
	.fieldType('updatedAt', 'number')
	.fieldType('moderation.reviewedAt', 'number')
	.index('updatedAt', { name: 'by_updated_at', directions: ['desc'] })
	.index('moderation.reviewedAt', { name: 'by_reviewed_at', directions: ['desc'] })
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('post', data.postId) : undefined,
		ancestorFields: ['postId'],
		unindexed: ['body']
	})
	.attach(Comment);

const ScopedComment = Comment.use(context) as typeof Comment;
const postKey = datastoreKey('post', 1);
await ScopedComment.ancestor(postKey).find(10).load();
await ScopedComment.ancestor(postKey).find(10).update({ body: 'edited' });
await ScopedComment.ancestor(postKey).find(10).delete();
await ScopedComment
	.under(postKey)
	.where({ postId: 1 })
	.orderBy({ field: 'updatedAt', direction: 'desc' })
	.load();
await ScopedComment
	.under(postKey)
	.where('moderation.state', '=', 'pending')
	.select('moderation.state', 'moderation.reviewedAt')
	.load();

const schemaPlans = await context.schemaPlan([Comment]);
const indexYaml = createDatastoreIndexYaml([context.meta(Comment)]);
```

Ancestor metadata is used for Datastore writes and `ancestor()`/`under()` query
scopes. Use `Model.ancestor(parent).find(id).load()` for parent-scoped id
lookups; direct `Model.find(id)` remains intentionally rejected for
ancestor-backed Datastore models because it cannot identify the parent key. For
low-level store calls, use `datastoreAncestorOptions(parentKey)` instead of
hand-writing `meta.datastoreAncestor`; it returns a typed options object accepted
by Datastore direct reads and writes.
`createDatastoreIndexYaml()` renders declared model indexes as Google Cloud
Datastore `index.yaml` content with the declared `asc`/`desc` direction for
each indexed field. Models that declare an ancestor resolver emit both
`ancestor: yes` and `ancestor: no` variants because active-ts supports scoped
and unscoped queries for those kinds; ordinary models emit only
`ancestor: no`. Because active-ts appends the model id as an ascending stable
tie-breaker for sorted limited queries, Datastore schema plans and generated
`index.yaml` entries include that id field when it is not already declared.
`context.schemaPlan([Model])`, direct `store.schema.plan([meta])`, and
`context.schemaApply([Model], { mode: 'safe' })` report Datastore composite
indexes as `status: 'manual'` deployment intent; they do not create remote
Datastore indexes. Use the plan in CI/review, generate the matching
`index.yaml`, and deploy that configuration through the Google Cloud Datastore
index workflow.

Portable Datastore filters, sorts, selections, and aggregate fields accept safe
dotted property paths such as `moderation.state`. Exact nested `fieldCodec()`
paths encode query operands before they reach the SDK. As with top-level Google
store sorts, every dotted sort field must be materialized on all matching rows
and declared with `fieldType()`; include composite dotted paths in model indexes
so schema plans and `createDatastoreIndexYaml()` emit the required properties.

Portable selections normally read complete Datastore entities and project
fields in active-ts. This preserves rows whose selected property is missing and
avoids duplicate rows from array property projections. An exact
`.select(idField)` is the safe exception: the adapter uses SDK
`select('__key__')` and reconstructs the typed id from the returned entity key.
If an injected client does not expose a reliable SDK key symbol, active-ts keeps
the full-row fallback. Transaction overlay queries also keep full rows so they
can merge buffered writes correctly.

Datastore key encoding is selected once per adapter. The default
`keyEncoding: 'active-ts'` preserves active-ts's canonical physical names:
numeric `17` is stored as the Datastore name `number:17`, while string `"17"`
is stored as the name `string:17`. Use `keyEncoding: 'native'` for existing
Google Datastore data whose SDK keys use numeric IDs for numbers and names for
strings:

```ts doc-test=fragment
const datastore = await createDatastoreStoreAdapter({
	client,
	keyEncoding: 'native'
});
```

Native encoding preserves the ID type in every root and ancestor key segment.
Thus number `17`, string `"17"`, and string `"number:17"` address three distinct
Datastore keys. Returned SDK keys are decoded from their `id` versus `name`
fields, and transactions use the same encoding as their parent adapter.
Numeric native IDs must be nonzero because Datastore reserves numeric ID `0`
for incomplete keys. Negative IDs round-trip for legacy data, but Google
discourages them and warns that future support is not guaranteed. Safe integers
use JavaScript numbers. For a signed 64-bit numeric ID outside JavaScript's
safe-integer range, use the opaque branded value returned by
`datastoreInt64Id()` in payload IDs, direct reads, query operands, bulk entries,
and every ancestor segment:

```ts doc-test=fragment
import { datastoreInt64Id, datastoreInt64IdValue } from 'active-ts';

const accountId = datastoreInt64Id('9223372036854775807');
const decimal = datastoreInt64IdValue(accountId);
```

Do not construct or persist the reserved wrapper representation manually.
`datastoreInt64Id()` accepts only canonical, nonzero signed int64 decimals that
cannot be represented safely as a number, and native key construction requires
the SDK client's `int()` helper. Payload IDs must use the same ID representation
as their physical key.

Before moving an existing kind to active-ts, inventory the SDK key `id`/`name`
and the payload ID for every row. Legacy data may contain a numeric physical key
`17` alongside payload ID `"17"`; active-ts rejects that mismatch to prevent
identity aliasing. Rewrite mismatched rows
under an explicit migration manifest before enabling the adapter. Represent the
default namespace as `undefined`, not an empty string, and inventory each
non-default namespace independently. Active-ts rejects `namespace: ''` at key,
adapter, context, inventory, and repair boundaries because the Datastore SDK can
alias it to the default namespace while an application might otherwise assign it
a distinct cache scope or physical identity. Applications upgrading from a build
that accepted an empty namespace should replace it with `undefined`, clear the old
entity-cache scope, rebuild search indexes, migrate queued outbox records, and
regenerate inventory and repair manifests instead of editing reviewed digests.

`inventoryDatastoreIds()` performs that inspection directly through a raw SDK
client without passing incompatible rows through the ORM adapter:

```ts doc-test=fragment
import { Datastore } from '@google-cloud/datastore';
import {
	inventoryDatastoreIds,
	type DatastoreIdInventoryIssue
} from 'active-ts/adapters/store/datastore';

const client = new Datastore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
const issues: DatastoreIdInventoryIssue[] = [];
const report = await inventoryDatastoreIds({
	client,
	kind: 'account',
	namespace: process.env.DATASTORE_NAMESPACE,
	pageSize: 500,
	onIssue: (issue) => {
		issues.push(issue);
	}
});

console.log(report.counts, issues);
```

The helper scans every page without a projection, preserves each key's full
ancestor path and whether every segment uses an SDK numeric `id` or string
`name`, and awaits `onIssue` for constant-memory manifest output. It reports
matching rows, type/value drift, missing or invalid payload IDs, and valid
Datastore numeric IDs that exceed active-ts's safe-integer range. Malformed SDK
keys, missing cursors, and repeated non-empty pages abort the scan rather than
returning an incomplete report. The Datastore emulator repeats its terminal
cursor with an empty page; that exact no-progress page is treated as the end.
A whole-kind query is not a transactional snapshot and may be eventually
consistent, so quiesce writers and rerun the inventory until consecutive
reports are stable before cutover. The helper is read-only; it never rewrites
mismatches.

Pure type drift can then be converted into a versioned, JSON-serializable
repair manifest. The recommended `key-wins` policy preserves the complete
physical key and changes only the payload ID type:

```ts doc-test=fragment
import {
	applyDatastoreIdRepairManifest,
	createDatastoreIdRepairManifest
} from 'active-ts/adapters/store/datastore';

const manifest = createDatastoreIdRepairManifest({
	report,
	issues,
	// Derive this from project, database, and endpoint configuration.
	target: 'gcp:my-project/(default)@datastore.googleapis.com',
	policy: 'key-wins',
	// Preserve the dataset's exact unindexed-field list, including [].
	excludeFromIndexes: ['body']
});

// Persist and review JSON.stringify(manifest) before this explicit apply step.
const approvedDigest = manifest.digest;
const applied = await applyDatastoreIdRepairManifest({
	client,
	manifest,
	target: 'gcp:my-project/(default)@datastore.googleapis.com',
	confirm: approvedDigest
});
```

Each inventory run assigns one UUID and contiguous issue indexes to its report
and callback rows. Its `issueDigest` also binds their ordered key paths,
payloads, classifications, and reasons to the report. Planning verifies that
every supplied issue comes from that exact run without content changes, that
all reported anomalies are captured, permits only
`type-mismatch` rows, rejects duplicate sources and targets, and requires the
inventory counts to contain no value mismatches, invalid IDs, missing IDs, or
unsupported keys. Those classifications require a model-specific manual
migration; active-ts never guesses which value is authoritative. Every apply
operation starts a separate Datastore transaction, rereads the source payload,
and aborts on stale inventory. An in-place repair is idempotent when its payload
was already fixed.

Use `policy: 'payload-wins'` only when the payload type is the intended public
identity. It changes the leaf key and therefore also requires
`allowKeyMoves: true`. Each transaction verifies that the target key is absent,
inserts the target, and deletes the source; manifest planning rejects move
chains and swaps. The plan must also declare `descendantPolicy:
'verified-none'` or `'migrated-separately'`; active-ts does not infer descendant
ownership. It does not move descendant entities or rewrite foreign keys,
ancestor resolver fields, Redis keys, search object IDs, or external
references. Inventory and migrate those dependencies explicitly before moving
a parent key.

`excludeFromIndexes` is mandatory because the Datastore SDK does not return the
original per-property exclusion flags when it reads an entity. Supply the exact
unindexed-field list so a rewrite neither creates unwanted indexes nor fails on
large values. If a later operation fails after earlier per-row
transactions committed, the helper throws `ActiveTsCommittedTransactionError`;
its `result` reports processed, repaired, already-repaired, and indeterminate
counts. A commit RPC can fail after the server committed, so an indeterminate
count requires a fresh inventory rather than replaying the old manifest.
`target` is copied into the reviewed manifest and must match at apply time; use
an environment-derived project/database/endpoint fingerprint so a staging
manifest cannot be accidentally applied through a production client. The
manifest digest covers its target, inventory identity, policy, keys, payload
expectations, and index exclusions. Record that digest separately during
review and pass the approved value as `confirm`; a changed manifest invalidates
the approval. Quiesce writers for the entire inventory/apply/rerun window,
rerun inventory after any partial result, and clear or rebuild external cache
and search data before routing traffic to active-ts. The repair helper
intentionally performs no cache or search invalidation.

Direct Datastore queries support opaque SDK continuation cursors through the
normal query API:

```ts doc-test=fragment
const firstPage = await Comment.query().orderBy('updatedAt').limit(100).load();
const nextPage = firstPage.more && firstPage.cursor
	? await Comment.query()
		.orderBy('updatedAt')
		.limit(100)
		.cursor(firstPage.cursor)
		.load()
	: undefined;
```

active-ts wraps the SDK cursor in a versioned Datastore envelope; treat it as
opaque and pass it back unchanged. A page that reports more results without an
advancing SDK `endCursor` fails instead of returning a looping cursor. Cursor
pagination is intentionally rejected for query scan fallback and buffered
transaction queries because those paths merge or reorder rows outside one SDK
query. The envelope's SHA-256 query fingerprint binds accidental reuse to the
resolved project, database, namespace, model, query, read policy, and key
encoding. It is a consistency check, not a keyed MAC or an authorization
mechanism; do not treat cursor contents as authenticated application input.
Native query callbacks remain responsible for their own cursor format.

Existing page-number routes can use the portable `offset()` API during a
migration:

```ts doc-test=fragment
const pageSize = 50;
const page = 3;
const result = await Comment.query()
	.orderBy('updatedAt')
	.offset((page - 1) * pageSize)
	.limit(pageSize)
	.load();
```

Direct Datastore queries map this to SDK `Query.offset()`, including ancestor
queries. Buffered transaction reads instead apply offsets after buffered
creates, updates, and deletes are merged so page boundaries reflect the
transaction view. Offset pagination is compatibility-oriented: Datastore still
processes skipped entities, so use continuation cursors for deep pages and batch
jobs. `offset()` and `cursor()` are mutually exclusive.

Datastore point-in-time and explicit-consistency reads are available without a
native callback. `readAt()` accepts an epoch-millisecond number or `Date`, while
`readConsistency()` accepts `strong` or `eventual`:

```ts doc-test=fragment
const readTime = new Date('2026-07-17T00:00:00.000Z');

const snapshot = await AuditRecord.find(42).readAt(readTime).load();
const page = await AuditRecord
	.query()
	.readAt(readTime)
	.orderBy('createdAt')
	.limit(100)
	.load();
const historicalCount = await AuditRecord.query().readAt(readTime).count();
const eventuallyConsistent = await AuditRecord
	.query()
	.readConsistency('eventual')
	.load();
```

For ancestor-backed models, scope the query before the historical id lookup:

```ts doc-test=fragment
const snapshot = await AuditRecord
	.ancestor(parentKey)
	.readAt(readTime)
	.find(42)
	.load();
```

`Model.find(id).readAt(...).load()` bypasses active-ts entity caches and does not
backfill them, so a historical row cannot replace the current cached value.
Queries and aggregates do not use entity caches. Models returned by `readAt()`
are read-only: instance `save()` and `delete()` fail before hooks or store calls.
Restore data deliberately with a current-state static update that selects the
fields to copy, or use the low-level store API when exact replacement semantics
are required. `readConsistency()` results are current-read models and remain
writable. Historical or explicitly consistent reads reject `include()` because
related rows would otherwise be loaded at a different snapshot; load each
relation explicitly with the same policy. They also reject query-builder
`find().update()` and `find().delete()`.

Low-level store handles can use the typed helper. Its optional `ancestor` field
combines the read policy and direct-read scope without hand-written metadata:

```ts doc-test=fragment
import { datastoreReadOptions } from 'active-ts';

const options = datastoreReadOptions({ readTime, ancestor: parentKey });
const snapshot = await context.store('datastore').get(meta, 42, options);
```

`readTime` and `consistency` are mutually exclusive. Active-ts maps the policy
to the second SDK argument for `get()`, `runQuery()`, and
`runAggregationQuery()`, including every query-scan fallback page and min/max
probe. Reuse the same `readAt()` value when following a continuation cursor.
Low-level `getMany()` calls with more than 1,000 unique IDs are split into SDK
lookup chunks only inside a Datastore transaction or with an explicit
`datastoreReadOptions({ readTime })`; otherwise they fail before backend access
instead of combining rows from different snapshots. Multi-spec aggregate scan
fallbacks likewise require a transaction or explicit `readTime`.
Datastore transactions reject per-operation read policies because the SDK does
not allow `readTime` or read consistency inside a transaction. Native query and
aggregate callbacks also reject the high-level policy because active-ts cannot
force a callback's SDK calls to use it; pass SDK read options inside that
callback when deliberately using the low-level escape hatch. Backend retention
and valid point-in-time windows remain Datastore service constraints.

Do not mix `active-ts` and `native` entities in the same database, namespace,
and kind. A valid native string name such as `"number:17"` is indistinguishable
from the physical name used for active-ts numeric ID `17`, so the adapter does
not perform fallback or dual reads. Choose the mode that matches the dataset
and migrate physical keys explicitly before changing it.

Datastore key compatibility does not make independently implemented caches
compatible. Use a single-writer cutover, disable entity caching during a
dual-writer window, or implement application-owned invalidation through the
generic plugin, transaction, and outbox APIs before either side writes shared
entities. Never assume that cache keys, codecs, or invalidation protocols are
interchangeable merely because the backing Datastore keys match.

If an ancestor-backed Datastore model declares search indexes, set
`datastore.ancestorFields` to the payload fields needed by the ancestor resolver.
Built-in projecting search adapters store and retrieve those fields even when
they are not searchable fields. Use `ancestorFields: []` only when the resolver
does not need payload fields, for example a constant or id-only ancestor key.

When `createDatastoreStoreAdapter({ namespace })` is configured, the adapter
namespace is part of the effective Datastore key even if an ancestor resolver
returns an unnamespaced `datastoreKey()`. Active-ts carries that effective
namespace into ancestor-scoped search document identities and outbox metadata,
so two Datastore contexts with different adapter namespaces can share a search
adapter without overwriting each other's ancestor-backed search documents. If an
ancestor resolver returns an explicit namespace, it must match the adapter
namespace.

Administrative import, restore, and tenant-maintenance code can share one
namespace-neutral SDK client while selecting a fixed namespace per operation:

```ts doc-test=fragment
import {
	createDatastoreNamespaceStoreFactory
} from 'active-ts/adapters/store/datastore';

const namespaceStores = await createDatastoreNamespaceStoreFactory({
	client,
	cacheScopePrefix: `${projectId}:${databaseId}`,
	keyEncoding: 'native'
});
const tenantStore = await namespaceStores.forNamespace(namespace);
const defaultNamespaceStore = await namespaceStores.forNamespace();
```

`forNamespace()` returns a complete `StoreAdapter`, including transaction
support when the shared client provides it. The returned adapter is permanently
scoped to that namespace; the factory never mutates `client.namespace` and does
not retain adapters in an unbounded tenant map. It rejects a fixed-namespace
client, `datastoreOptions.namespace`, and top-level `namespace` or `cacheScope`
options because those would make per-operation selection ambiguous.
Native query callbacks deliberately receive the shared raw SDK client and may
address another namespace; use that low-level escape hatch only when the
callback validates its target namespace explicitly.

Every `DatastoreStoreAdapter`, including adapters returned by `forNamespace()`,
also exposes low-level batch mutations for import, restore, and maintenance
jobs:

```ts doc-test=fragment
const meta = context.meta(Account);

await tenantStore.bulk.upsertMany(meta, [
	{ id: 1, data: { id: 1, email: 'one@example.com' } },
	{ id: 2, data: { id: 2, email: 'two@example.com' } }
], { chunkSize: 500 });

await tenantStore.bulk.deleteMany(meta, [1, 2]);
```

`upsertMany()` has explicit update-or-insert semantics, unlike the strict
single-row `create()` and `update()` methods. It applies the model's static
`datastore.unindexed` fields and validates typed ids, payload ids, native key
encoding, namespace, and ancestors before the first SDK call. For an
ancestor-backed delete, provide the physical ancestor per entry:

```ts doc-test=fragment
await tenantStore.bulk.deleteMany(meta, [{
	id: 7,
	options: {
		meta: { datastoreAncestor: datastoreKey('account', 1) }
	}
}]);
```

The default mode uses non-transactional SDK batch calls. `chunkSize` bounds
each call, but already-completed chunks remain committed if a later call fails.
Datastore can also partially apply the mutations within one failed
non-transactional commit. Use `{ atomic: true }` when all mutations must commit
together; it opens one Datastore transaction and cannot be combined with
`chunkSize`. The whole transaction must remain within Datastore's transaction
size and runtime limits. Before any SDK write, active-ts applies a defensive
protobuf-size estimate with an 8 MiB request budget below Datastore's 10 MiB API
request limit and the documented per-entity limit. Non-atomic batches split on
that budget; an oversized atomic batch is rejected in full before its
transaction starts. The estimate is intentionally conservative and does not
replace backend limits.

This is intentionally a raw adapter API. Its `data` is the encoded store
representation, and it does not run model validation, field codecs, hooks,
entity-cache invalidation, search synchronization, or outbox plugins. Prefer it
for quiesced administrative jobs. Online model writes should continue through
`Model.create()`, `save()`, and `delete()` so lifecycle side effects remain
coherent. Non-transactional batch behavior follows the
[Datastore batch operation contract](https://cloud.google.com/datastore/docs/concepts/entities#batch_operations),
and atomic mode follows the
[Datastore transaction contract](https://cloud.google.com/datastore/docs/concepts/transactions).

Entity caches also use the physical store identity. The Datastore adapter
derives `StoreAdapter.cacheScope` from configured project, database, and
namespace values. Native key encoding adds a distinct suffix while the default
active-ts scope remains backward compatible. For an internally created SDK
client, adapter construction awaits `client.getProjectId()`, so Application
Default Credentials are bound to the resolved project in cache scopes and
cursor fingerprints. An injected client is caller-owned and may implement that
method with arbitrary work, so active-ts does not call it during registration;
only an own `client.options.projectId` data property is used. If either project
or database identity cannot be verified, injected clients receive a random
per-client scope component. Pass an explicit stable scope when separate client
objects or process restarts should reuse the same cache keys:

```ts doc-test=fragment
const datastore = await createDatastoreStoreAdapter({
	client,
	namespace,
	cacheScope: `${projectId}:${databaseId}:${namespace}`
});
```

The resolved or explicitly configured project is exposed as
`StoreAdapter.datastoreProjectId`; `undefined` means an injected client did not
declare one. An internal SDK resolution failure or any invalid project ID fails
adapter construction. The adapter also snapshots the SDK's synchronous
`getDatabaseId()` as `StoreAdapter.datastoreDatabaseId`:
`null` means the SDK default database and a string names an explicit database;
`undefined` means the client did not expose a verifiable database identity.
`StoreAdapter.datastoreKeyEncoding` similarly exposes `"active-ts"` or
`"native"`. Context, transaction, savepoint, read-only, and middleware handles
preserve all three values so migration integrations can verify the physical store
before handling traffic.

`cacheScope` is opaque to active-ts and must identify the complete physical
store addressed by that adapter, including its key encoding. When setting an
explicit scope, include the mode yourself. Store middleware and transaction wrappers
preserve it. `datastoreOptions` configures only clients created by active-ts and
does not describe an injected client's identity. Custom store adapters should expose a non-empty stable
`cacheScope` whenever two adapter instances using the same model names and ids
can point at different physical data while sharing a cache.

For `createDatastoreNamespaceStoreFactory()`, `cacheScopePrefix` identifies the
shared physical project and database. The factory length-prefixes that identity,
the key encoding, and the namespace so arbitrary component contents cannot
collide. Supply a stable prefix when distributed cache entries must survive
process restarts; without it, adapters from the same factory still share a
per-client identity and remain isolated from every other namespace.

When the injected Datastore client exposes `transaction()`, the Datastore store
adapter advertises active-ts transaction support and routes transactional
`get`, `query`, `create`, `update`, and `delete` calls through the SDK
transaction object. Active-ts read-only transactions reject writes in the
transaction-scoped store. Portable isolation levels and timeouts are not mapped
for Datastore and fail fast; Datastore's normal entity-group transaction
constraints still apply. Datastore does not expose portable savepoints, so
`join: 'savepoint'` fails before running the nested callback. Write transactions
keep Datastore native function queries enabled and pass the transaction-scoped client to the native callback;
read-only transactions reject native store reads because native callbacks can
perform arbitrary SDK work. Datastore transaction `native` options may pass SDK
call options with `gaxOptions`, `commitGaxOptions`, and `rollbackGaxOptions` for
the SDK begin/commit/rollback calls. `maxAttempts` opts into retrying `ABORTED`
conflicts; `retryInitialDelayMs`, `retryMaxDelayMs`, and `retryJitter` control
bounded exponential backoff with jitter. The transaction callback can run up to
`maxAttempts` times, so it must be idempotent and must not perform irreversible
external side effects unless the application deduplicates or defers them.
Definitive commit rejections are returned as ordinary failures, while transport
errors with an unknowable commit outcome fail closed as unknown outcomes.
Datastore mode databases using
`OPTIMISTIC_WITH_ENTITY_GROUPS` can set
`requireAncestorTransactionQueries: true` on `createDatastoreStoreAdapter()` to
reject transaction `query()` and `aggregate()` calls, including native callback
plans, unless they carry `meta.datastoreAncestor`.

MongoDB adapters expose active-ts transaction support when the client provides
`startSession()`. All portable reads and writes receive the same MongoDB session,
and active-ts serializes their driver calls because the MongoDB driver does not
support parallel operations within one transaction. Transaction-scoped handles
close after callback settlement, do not expose schema or nested transaction
methods, and reject native query payloads so a callback cannot silently execute
outside the session. Read-only transactions reject portable writes.

Set `cacheScope` to an opaque, stable identity for the complete physical MongoDB
store when multiple processes share a distributed entity cache. Include every
boundary that can hold different rows for the same model name and id, such as
cluster and database identity. active-ts does not derive this value from `url`
because connection strings can contain credentials and aliases; adapters without
an explicit scope can only use local cache ownership, and models configured for
distributed cache consistency reject them. Empty scopes and scopes containing
null bytes are rejected. Transaction-scoped MongoDB adapters preserve the parent
scope.

MongoDB does not map portable `isolation` levels and does not expose savepoints.
`timeoutMs` becomes the session's client-side timeout and is also applied to
commit and abort. `native` accepts MongoDB `readConcern`, `writeConcern`,
`readPreference`, and `maxCommitTimeMS` transaction options. active-ts uses the
MongoDB Core API rather than `withTransaction()`: it runs the application
callback exactly once and invokes `commitTransaction()` once. MongoDB 7 may
internally retry a retryable commit command; that driver behavior never reruns
the application callback. Only an error carrying MongoDB's
`UnknownTransactionCommitResult` label is exposed as
`ActiveTsUnknownTransactionOutcomeError` with `phase === "commit"`,
`outcome === "unknown"`, and the driver error in `cause`. It suppresses both
commit and rollback hooks. `TransientTransactionError`, `NoSuchTransaction`,
`WriteConflict`, and unlabeled commit failures use definitive rollback
semantics. Applications must reconcile an unknown outcome rather than blindly
retrying the unit of work.

The MongoDB 7 driver retries one retryable abort command and normally suppresses
abort command failures as required by the transactions specification. If an
injected session implementation does reject `abortTransaction()`, active-ts
reports `ActiveTsUnknownTransactionOutcomeError` with `phase === "abort"`.
MongoDB transactions require a replica set or sharded cluster.

Firestore adapters expose active-ts transaction support through
`client.runTransaction()`. Transaction-scoped `get`, `getMany`, `query`,
`create`, `update`, and `delete` calls run through the SDK transaction object.
Firestore requires transaction reads before writes, so active-ts returns
buffered rows for ids written in the same transaction and rejects unbuffered
reads after a write with a clear configuration error. Firestore transaction
queries do not support native function payloads, portable isolation levels, or
timeouts. Firestore SDK transactions do not expose portable savepoints, so
`join: 'savepoint'` fails before running the nested callback. Transaction
`native` options may pass the Firestore SDK transaction options `maxAttempts`,
`readOnly`, and `readTime`; active-ts `readOnly` is merged
into those SDK options and rejects writes before reaching the SDK transaction
object.

## Cache Adapters

| Adapter | Package import | Peer dependency | Notes |
| --- | --- | --- | --- |
| Memory | `active-ts/adapters/cache/memory` | none | test-only cache with snapshots and stats |
| Redis/Valkey | `active-ts/adapters/cache/redis-valkey` | `redis` | batch `mGet`, JSON payloads, TTL support, optional cache codec |

Supported peer range: `redis` `^5.0.0`.

Example:

```ts doc-test=typecheck
import { createRedisValkeyCacheAdapter } from 'active-ts/adapters/cache/redis-valkey';

const cache = await createRedisValkeyCacheAdapter({
	url: process.env.REDIS_URL
});
```

Cache codecs can wrap any cache adapter, or be passed directly to Redis/Valkey
for encryption-style extensions:

```ts doc-test=fragment
import { createAesGcmCacheCodec, createCodecCacheAdapter } from 'active-ts';

const cacheKey = Buffer.from(process.env.CACHE_ENCRYPTION_KEY!, 'base64url');

const encryptedCache = createCodecCacheAdapter(
	cache,
	createAesGcmCacheCodec({ key: cacheKey })
);

const redisWithCodec = await createRedisValkeyCacheAdapter({
	url: process.env.REDIS_URL,
	codec: createAesGcmCacheCodec({ key: cacheKey })
});
```

## Search Adapters

| Adapter | Package import | Peer dependency | Notes |
| --- | --- | --- | --- |
| Memory | `active-ts/adapters/search/memory` | none | searches declared fields and supports process-local revision writes for tests |
| Native | `active-ts/adapters/search/native` | none | maps search fields to store `textContains` queries |
| Algolia | `active-ts/adapters/search/algolia` | `algoliasearch` | validates writes; revision-ordered writes are unsupported |
| Elasticsearch | `active-ts/adapters/search/elasticsearch` | `@elastic/elasticsearch` | supports persistent revision writes and delete tombstones |

Supported peer ranges:

- `algoliasearch`: `^5.0.0`
- `@elastic/elasticsearch`: `^8.0.0`

Example:

```ts doc-test=typecheck
import { createElasticsearchSearchAdapter } from 'active-ts/adapters/search/elasticsearch';

const search = await createElasticsearchSearchAdapter({
	node: process.env.ELASTICSEARCH_URL
});
```

Built-in search adapters keep the projected document's id field as the logical
model id. For ancestor-backed Datastore search sync they may use a separate
bounded backend document key, so remote `objectID`/`_id` values are not required
to decode to the same logical id when the stored document includes the id field.

Search adapters can advertise `capabilities.revisionWrites: true` and accept a
monotonic write fence:

```ts doc-test=typecheck
import type { ResolvedModelMeta, SearchAdapter } from 'active-ts';

declare const search: SearchAdapter;
declare const meta: ResolvedModelMeta;

await search.index(meta, 1, { id: 1, name: 'Ada' }, { revision: 42 });
await search.delete(meta, 1, { revision: 43 });
```

For a given physical document identity, only a revision strictly greater than
the retained revision may change state. Older and equal writes resolve as
successful no-ops. A revisioned delete must retain its revision indefinitely so
a delayed lower-revision index cannot recreate the document. Elasticsearch
implements this with external versions and hidden tombstone documents; normal
search results exclude those tombstones. Memory retains revisions until
`clear()`. Adapters without the capability reject revision options instead of
silently weakening the contract. Elasticsearch indexes with strict mappings
must allow the reserved `active_ts_deleted` boolean field. Index replacement
must preserve tombstones, or stop search writers and replay authoritative rows
with newer revisions before accepting delayed traffic; deleting the target
index also deletes its retained fences. `requireRevisionWrites: true` rejects
direct index and delete calls without a revision. Enable it only after stopping
or draining older workers, and keep it enabled once all writers share the same
durable revision allocator.

## Registering Adapters

```ts doc-test=fragment
const context = createActiveTs({
	defaultStore: 'primary',
	defaultCache: 'cache',
	defaultSearch: 'search',
	stores: { primary: store },
	caches: { cache },
	search: { search }
});
```

Per-model metadata can override defaults:

```ts doc-test=fragment
defineModel<AccountData>({
	name: 'account',
	store: 'primary',
	cache: { adapter: 'cache', ttl: 60 },
	search: 'search'
});
```

Adapters can be wrapped with middleware before registration:

```ts doc-test=fragment
const store = createStoreMiddlewareAdapter(postgres, [traceStore(), retryStore()]);
const cache = createCacheMiddlewareAdapter(redis, [cacheMetrics()]);
const search = createSearchMiddlewareAdapter(elasticsearch, [searchMetrics()]);
```

Middleware runs at the adapter boundary and is useful for retry, tracing,
metrics, tenancy, rate limits, and SDK-specific policies.

## Native Hooks

Store and search builders expose `native()` for backend-specific operations:

```ts doc-test=fragment
await Account.query().native({
	text: 'select data from "account" where id = $1',
	values: ['1']
}).load();
```

`native()` bypasses the shared DSL. Treat it as trusted-only code and keep
values parameterized through the target SDK.

Native search wraps a store adapter. Portable native search still returns the
same projected search-document shape as other search adapters, not arbitrary
full store rows. If a searched field uses a field codec, the codec must provide
`encodeQuery` and opt in to `queryOperators: ['textContains']` so native search
can query the stored representation safely.

## Schema Planning

Adapters may implement:

- `schema.plan(models)` - report collections/tables/indexes that would be
  created
- `schema.apply(models, { mode: 'safe' })` - apply non-destructive changes

PostgreSQL and MongoDB can create collections/tables and indexes. Firestore
reports index intent but does not apply remote index configuration.

## Adapter Contract

Adapter authors should run the shared contracts for every adapter kind they
provide:

```ts doc-test=fragment
import {
	runCacheAdapterContract,
	runSearchAdapterContract,
	runStoreAdapterContract
} from 'active-ts/testing';

await runStoreAdapterContract(adapter);
await runCacheAdapterContract(cache);
await runSearchAdapterContract(search);
```

Store adapters that advertise backend-specific native query support with
`capabilities.native: true` must pass `nativeProbe` to
`runStoreAdapterContract()` and assert a native payload reaches the expected
backend handle:

```ts doc-test=fragment
await runStoreAdapterContract(adapter, {
	nativeProbe: async ({ adapter, model }) => {
		const rows = await adapter.query(model, {
			native: {
				payload: (input: { model: { name: string }; plan: { native?: unknown } }) => {
					const { model: nativeModel, plan } = input;
					if (nativeModel.name !== model.name || plan.native == null) {
						throw new Error('native payload was not routed');
					}
					return backend.collection(model.name).where('name', '==', 'alpha');
				}
			},
			where: [],
			or: [],
			sort: [],
			include: []
		});
		if (rows.list.length !== 1) {
			throw new Error('native probe did not read the expected row');
		}
	}
});
```

If a search backend is eventually consistent, pass an explicit polling window:

```ts doc-test=fragment
await runSearchAdapterContract(search, {
	settleMs: 5_000,
	pollIntervalMs: 100
});
```

For multiple store adapters:

```ts doc-test=fragment
await createAdapterContractSuite({
	memory: () => new MemoryStoreAdapter(),
	postgresql: () => createPostgresStoreAdapter({ pool })
}, {
	nativeProbe: async ({ adapter, model }) => {
		// Assert backend-specific native routing for native-capable adapters.
		await adapter.query(model, {
			native: {
				payload: (input: { model: { name: string } }) => input.model.name
			},
			where: [],
			or: [],
			sort: [],
			include: []
		});
	}
}).run();
```

The store contract checks create, duplicate-create conflict behavior, get,
getMany, requested-id validation for direct reads, query, update, delete, typed
id collisions, projection id inclusion, OR branches, `startsWith`, explicit
containment operators, missing-field null semantics, nested fields, native
function query payloads with required backend-aware probes, aggregates, cursor
pagination, offset pagination, and safe schema application where the adapter
advertises support.

Store adapters must return a boolean `more` value for limited portable queries.
Adapters that do not advertise active-ts cursor support must not expose backend
native cursors through `QueryResult.cursor`; they can still report `more: true`
to indicate that the returned page was trimmed.

The cache contract checks key validation, duplicate-key `setMany()` rejection,
`getMany()` ordering, cloning, TTL expiry, delete behavior, and invalid-write
atomicity. The search contract checks declared-field projection, typed id
isolation, delete/reindex behavior, result shape, unsafe index payload rejection,
unsupported option fail-fast behavior, and search schema plan normalization when
available. For backend-specific native search support, adapters that advertise
`capabilities.native: true` must pass `nativeProbe` to `runSearchAdapterContract()`
and assert a native payload reaches the expected adapter path.
`runSearchAdapterContract()` is an indexing contract and requires
`capabilities.index: true`; use a separate read-only adapter test if an adapter
intentionally cannot index.

Search adapters follow the same portable cursor rule as store adapters: only
adapters that advertise cursor support may expose `QueryResult.cursor`.

## Aggregate Optimization

`StoreAdapter.aggregate()` is optional. Query builders call it when available.
If an adapter does not support native aggregates, active-ts rejects aggregate
helpers by default; opt into the filtered `query()` fallback only with
`aggregate.allowQueryFallback: true`.

```ts doc-test=fragment
const total = await Account.query().where('score', '>=', 10).sum('score');
```

Built-in optimized paths:

- memory computes aggregates without incrementing query stats
- PostgreSQL emits `count`, `sum`, `avg`, `min`, and `max` SQL aggregates
- MongoDB emits one aggregation pipeline with `$group` for `count`, `sum`, and
  `avg`
- Datastore uses aggregation queries for `count`, `sum`, and `avg`; with
  `allowAggregateScanFallback: true`, it can instead run a validated full-row
  query scan. `min` and `max` use ordered `limit(1)` lookups for fields declared
  with scalar `fieldType()` metadata unless scan fallback is enabled. At most
  five aggregate specs are accepted. Specs that would require more than one
  native backend request are rejected rather than combining different
  snapshots; a multi-spec scan requires an explicit `readTime` or transaction
- Firestore uses aggregate queries for `count`, `sum`, and `avg`; `min` and
  `max` use an ordered `limit(1)` lookup only for fields declared with
  scalar `fieldType()` metadata

Some backend SDKs cannot express every portable aggregate semantic natively.
MongoDB `min`/`max`, Datastore emulator-safe full-row aggregate scans, and
Firestore aggregate paths that cannot use SDK aggregate helpers or typed
`min`/`max` lookups require the adapter-level
`allowAggregateScanFallback: true` option before active-ts will run a validated
scan. This option is separate from the context-level
`aggregate.allowQueryFallback: true`: the context option controls stores that
omit `aggregate()`, while the adapter option controls built-in backend scans.

Custom store adapters can omit `aggregate()` while prototyping by enabling the
explicit fallback in test/dev contexts. Production adapters should implement
native aggregate support or leave aggregate helpers unsupported.

Datastore array properties have different scalar-filter semantics from the
portable active-ts evaluator. For scalar fields without `fieldType()` metadata,
the adapter therefore treats native `=`, `in`, `between`, and range filters only
as candidate selectors, reads every candidate page, applies portable filtering
and stable sorting, and only then applies `offset` and `limit`. Untyped `!=` and
`isNotNull`, and every `isNull`, can require a whole-kind scan because a native
filter may omit portable matches; these paths require
`allowQueryScanFallback: true`. All portable post-filter paths reject
continuation cursors because one SDK cursor cannot represent the resulting
page boundary. Declare truly scalar fields with `fieldType()` to enable direct
native filtering where its semantics are equivalent. Leave full-scan fallback
disabled in production unless a bounded scan is intentionally acceptable.

Firestore and Datastore portable `orderBy()` plans require the sorted field to
be the model id field or a declared `fieldType()` path. Google backends can omit
rows where the ordered property is missing, so sortable non-id fields should be
materialized and declared in model metadata. Firestore and Datastore also reject
`limit()` queries that have inequality filters but no explicit first
`orderBy()`/`order()` on an inequality field; add the sort yourself so limited
pages have a portable ordering contract.

MongoDB portable `orderBy()` follows the same metadata requirement for non-id
fields. MongoDB's native ordering for missing, null, arrays, objects, and mixed
scalar values differs from active-ts' portable comparator, so declare sortable
scalar fields with `fieldType()`.
