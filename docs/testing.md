# Testing

`active-ts/testing` provides two testing layers:

- app test contexts for projects that use active-ts models
- adapter contracts and integration harnesses for adapter authors

## App Test Context

Use `createTestContext()` with `withTestContext()` to install deterministic
memory store/cache/search adapters for one test:

```ts doc-test=fragment
import {
	createTestContext,
	expectNoLazyLoadWarnings,
	fixture,
	seed,
	snapshotStore,
	withTestContext
} from 'active-ts/testing';

await withTestContext(createTestContext(), async (ctx) => {
	await seed(Account, [{ id: 1, handle: 'seorii' }]);
	await fixture(Rank, { id: 1, rank: 10, tier: 4 });

	const account = await Account.find(1).include('rank').load();

	console.log(account?.data.handle);
	console.log(snapshotStore(Account));
	console.log(ctx.stats().store);
});
```

The previous default context is restored automatically after the callback.
Global installation mutates `console.warn` and the default active-ts context, so
overlapping installs are rejected. For parallel tests, use bound models with the
async-local helper context and disable global installation:

```ts doc-test=fragment
const ctx = createTestContext();
const AccountInTest = Account.use(ctx.context);

await withTestContext(
	ctx,
	async () => {
		await seed(AccountInTest, [{ id: 1, handle: 'parallel' }]);
		const account = await AccountInTest.find(1).load();
		assert.equal(account?.data.handle, 'parallel');
	},
	{ install: false }
);
```

## Fixtures and Snapshots

Helpers operate on the current test context:

- `seed(Model, rows)` - insert multiple rows
- `fixture(Model, row)` - insert one row and return it
- `snapshotStore(Model?)` - inspect memory store contents
- `resetTestContext(Model?)` - clear one model or all memory state; `await`
  this when adapters provide async cleanup helpers

The memory adapters expose stats for query/cache assertions:

```ts doc-test=fragment
assert.equal(ctx.stats().store?.getMany, 1);
assert.equal(ctx.stats().cache?.hits, 2);
```

## Lazy-Load Warnings

By default, `createTestContext()` captures lazy-load warnings instead of printing
them. This makes relation loading behavior testable.

```ts doc-test=fragment
await expectNoLazyLoadWarnings(async () => {
	const account = await Account.find(1).include('rank').load();
	await account?.rank;
});
```

Warning modes:

- `capture` - collect warnings in `ctx.warnings`
- `throw` - throw when a lazy-load warning occurs
- `console` - leave `console.warn` behavior unchanged
- `off` - disable lazy-load warnings in the active context

```ts doc-test=fragment
const ctx = createTestContext({ lazyLoadWarnings: 'throw' });
```

## Hooks, Plugins, and Function Caches

`createTestContext({ config })` accepts the same non-adapter context options as
`createActiveTs()`, including plugins. This makes lifecycle assertions
deterministic without booting the whole app.

```ts doc-test=fragment
const events: string[] = [];

await withTestContext(
	createTestContext({
		config: {
			plugins: [
				{
					name: 'audit-test',
					hooks: {
						afterUpdate: ({ id }) => events.push(`updated:${id}`)
					}
				}
			]
		}
	}),
	async () => {
		const account = await Account.create({ id: 1, handle: 'seorii' });
		await account.save();
	}
);
```

Function caches can use the test context's memory cache:

```ts doc-test=fragment
const profileCache = createFunctionCache({
	prefix: 'profile-test',
	context: ctx.context,
	factory: async (id: number) => ({ id })
});

await profileCache.get(1);
assert.equal(profileCache.stats.misses, 1);
```

## Using Real Services

active-ts does not hard-depend on Docker, Testcontainers, or a specific emulator
runner. Bring your own lifecycle and wrap it with `createIntegrationHarness()`.

```ts doc-test=fragment
const postgresHarness = createIntegrationHarness({
	name: 'postgresql',
	start: () => startPostgresContainer(),
	stop: (container) => container?.stop(),
	createStore: ({ connectionString }) =>
		createPostgresStoreAdapter({ connectionString })
});

await postgresHarness.runStoreContract();
```

Use `IntegrationHarness<TResource>` for the factory input shape and
`IntegrationHarnessApi<TResource>` for a reusable harness returned by
`createIntegrationHarness()`.

Native-capable store harnesses pass the same backend-specific probe accepted by
`runStoreAdapterContract()`:

```ts doc-test=fragment
await postgresHarness.runStoreContract({
	nativeProbe: async ({ adapter, model }) => {
		await adapter.query(model, {
			native: {
				payload: { text: `select data from "${model.name}" where data->>'name' = $1`, values: ['alpha'] }
			},
			where: [],
			or: [],
			sort: [],
			include: []
		});
	}
});
```

Harnesses are store-only unless `createCache` or `createSearch` is supplied.
When those factories are present, run the matching contracts too:

```ts doc-test=fragment
await redisHarness.runCacheContract();
await elasticsearchHarness.runSearchContract();
```

Search backends that make index/delete operations visible asynchronously can
run the same contract with an explicit polling window:

```ts doc-test=fragment
await elasticsearchHarness.runSearchContract({
	settleMs: 5_000,
	pollIntervalMs: 100,
	nativeProbe: async ({ adapter, model }) => {
		const nativeOnlyModel = { ...model, searchIndexes: [] };
		const result = await adapter.search(nativeOnlyModel, 'ignored', {
			native: { query: { match: { title: 'alpha' } } }
		});
		if (result.list.length !== 1) {
			throw new Error('native search probe did not read the expected row');
		}
	}
});
```

The store contract verifies core CRUD, query, aggregate, transaction, savepoint, and
capability behavior, including requested-id validation for direct reads,
malformed transaction callback and option rejection, transaction callback result
and error propagation, completion of store operations that are still in flight
when transaction callbacks settle, concurrent same-id direct reads observing
writes invoked before them, concurrent same-id delete/recreate mutations
preserving invocation order, unobserved operation failures still forcing rollback
when observed only after callback closure, retained handles rejecting new work
while callback operations drain, callback errors taking precedence over concurrent
unobserved operation failures, Datastore ancestor query/write/aggregate metadata
isolation when advertised, scoped and unscoped schema index modes for Datastore
ancestor models, direction-preserving unique schema index plans, and native
function query payloads when advertised. Store adapters that advertise
backend-specific native payload support must pass `nativeProbe`, because the
shared contract can verify portable native routing but cannot infer each
backend's native handle semantics.
Transaction-capable stores must also hide schema and nested transaction hooks
from transaction callback adapters, then close those adapters after commit or
rollback so retained reads and writes reject. Stores advertising savepoints must
declare boolean savepoint capabilities and expose matching `savepoint()` methods
at every transaction, child, and nested-child callback boundary. Savepoint
callbacks must run exactly once and pass nested, rollback-isolation,
concurrent-parent-ordering, callback-validation, and retained child-handle checks.
The cache contract verifies key
validation, duplicate-key `setMany()` rejection, result order, cloning, TTL
expiry, deletes, and invalid-write atomicity. The search contract verifies
declared-field projection, typed id isolation, Datastore ancestor document
identity markers, delete behavior, result shape, exact total metadata when
deterministic fixtures provide it, unsafe indexing input rejection, eventual
visibility when configured, and unsupported option fail-fast behavior. Adapters
that advertise `revisionWrites` are also checked for stale/equal index no-ops,
delete fences, and resistance to lower-revision document resurrection. Search
adapters that advertise backend-specific native payload support must pass
`nativeProbe`, because the shared contract cannot infer adapter-specific native
semantics. Because it writes and deletes index documents,
`runSearchAdapterContract()` requires `capabilities.index: true`.

`createTestContext()` still uses memory cache/search defaults for unit tests,
but integration harnesses do not silently add those layers.

When a test needs direct access to the context, `createContext()` returns a
handle with idempotent cleanup:

```ts doc-test=fragment
const handle = await postgresHarness.createContext();
try {
	await handle.context.seed(Account, [{ id: 1, handle: 'direct' }]);
} finally {
	await handle.close();
}
```

`withContext(fn, { install: false })` keeps the context in async-local test
state without installing it as the process-global active-ts default. Use bound
models from the provided context when running harness tests in parallel.

Datastore and Firestore should use their official emulators or an app-provided
local test library. MongoDB, PostgreSQL, Redis/Valkey, and Elasticsearch fit the
same harness shape with Testcontainers, Docker Compose, or already-running CI
services.

The SQLite adapter is tested against the real `node:sqlite` engine in the
normal unit suite, including temporary-file persistence, queries, aggregates,
indexes and transaction lifetimes. Its shared store contract also runs in the
backend integration and release workflows. To run it without external services:

```sh
ACTIVE_TS_INTEGRATION_TARGETS=sqlite pnpm test:integration:backends
```

Redis and Valkey share `createRedisValkeyCacheAdapter()`, but run as separate
integration targets against separate servers. To exercise a running Valkey
instance independently:

```sh
VALKEY_URL=redis://127.0.0.1:6380 \
ACTIVE_TS_INTEGRATION_TARGETS=valkey pnpm test:integration:backends
```

The Valkey target requires `INFO server` access to verify the server identity,
then runs the shared cache contract using a random key prefix. Connection
failures stop after a five-second connection timeout without automatic retries.

The repository backend smoke runner also accepts Google emulator targets:

```sh
DATASTORE_EMULATOR_HOST=127.0.0.1:8081 \
FIRESTORE_EMULATOR_HOST=127.0.0.1:8082 \
GOOGLE_CLOUD_PROJECT=active-ts-emulator \
ACTIVE_TS_INTEGRATION_TARGETS=datastore,firestore \
pnpm test:integration:backends
```

Datastore uses a random namespace for each run. Its smoke coverage also creates
two adapters through `createDatastoreNamespaceStoreFactory()` and verifies that
the same kind and id remain isolated across namespaces while sharing one SDK
client. Firestore uses randomized collection names from the adapter contract.
The runner fails fast when Google targets are selected without emulator
environment variables. Real GCP backend smoke requires both
`ACTIVE_TS_ALLOW_REAL_GCP_BACKEND_SMOKE=true` and
`ACTIVE_TS_REAL_GCP_BACKEND_PROJECTS` containing the selected
`GOOGLE_CLOUD_PROJECT`.

The Datastore emulator accepts SDK `readTime` options but does not preserve
historical entity versions. Emulator smoke therefore verifies current
point-in-time request plumbing and explicit strong consistency. When the same
runner is explicitly allowed to target real GCP, it updates a row and verifies
that `readAt()` point reads and aggregates still observe the pre-update
snapshot. Fake-SDK regressions separately assert the exact read options passed
to point, query, aggregate, min/max, and multi-page scan calls.

## Seeded Search Fuzzing

The Meilisearch and OpenSearch integration targets run
[`search-fuzz.mjs`](../test/integration/search-fuzz.mjs) against the real service
after the shared search contract. Each of two fixed seeds exercises 100 random
operations plus deterministic edge cases. An independent reference map checks
full replacement, deletion, numeric/string IDs, custom ID fields, declared
projection, result limits, marker queries and pagination after mutations.
OpenSearch additionally generates newer, equal and older revisions and verifies
that stale indexes/deletes cannot overwrite the latest state or resurrect a
deleted document. Meilisearch rejects explicit write revisions because it cannot fence stale
writes. Test indexes disable typo tolerance and prefix matching so the oracle
compares exact marker membership without depending on search ranking.

To run or replay a seed against your local Meilisearch server:

```sh
MEILISEARCH_URL=http://127.0.0.1:7700 \
ACTIVE_TS_INTEGRATION_TARGETS=meilisearch \
ACTIVE_TS_SEARCH_FUZZ_SEEDS=1592594996 \
ACTIVE_TS_SEARCH_FUZZ_ITERATIONS=100 \
pnpm test:integration:backends
```

When the server uses a master key, set `MEILISEARCH_API_KEY` to a fixture admin
credential. The runner creates an expiring, index-scoped key with only the
`search` action and verifies that adapter searches succeed while metadata reads
and writes return HTTP 403. It removes the temporary key and indexes afterward.
CI uses a public test-only master key on its disposable service and requires this
probe; a missing admin key fails. Locally, set
`ACTIVE_TS_MEILISEARCH_REQUIRE_AUTH=true` to require the same authenticated run.
A local server without authentication can still run the search contract and
fuzzing by omitting both variables.

For OpenSearch use `ACTIVE_TS_INTEGRATION_TARGETS=opensearch` and set
`OPENSEARCH_URL` (default `http://127.0.0.1:9201`) with the same fuzz environment
variables. Its fixture refreshes after mutations and uses native pagination.

Failure output includes the backend, seed, operation and replay environment.
The runner creates isolated indexes and removes them on completion. These are
bounded, reproducible state-machine fuzz tests, not exhaustive input coverage,
coverage-guided fuzzing, or evidence of production failover and load capacity.
Task failures, cancellation, timeouts and malformed SDK responses are separately
covered by injected-client regressions in the default suite.

## Capability Evidence

The [store capability matrix](adapters.md#portable-store-capability-matrix)
describes the public support boundary. Use the existing contracts to verify an
adapter rather than treating every passing test as proof of supported features:

| Evidence | Existing executable check | What it establishes |
| --- | --- | --- |
| Supported portable operations | [`runStoreAdapterContract()`](../src/testing/index.ts) | Declared features perform their positive contract, including projection ID inclusion, optimistic writes, and transaction handle lifetime. |
| Unsupported operations | The same contract's unsupported-capability checks; [`capability-regression.test.ts`](../test/capability-regression.test.ts) | Missing/false capabilities reject; ORM guards can reject before adapter execution. PostgreSQL `select` belongs here. |
| Incorrect adapter declarations | [`adapter-contract-regression.test.ts`](../test/adapter-contract-regression.test.ts) | Deliberately broken adapters cannot pass the shared contract merely by declaring a capability. |
| Transaction point-read conflicts | The shared contract when `transactionConflictDetection: true` | Concurrent `get`/`getMany` read-modify-write schedules do not silently lose a write. This probe does not run for PostgreSQL or SQLite, which declare it false. |
| Native backend routing | Required backend-aware `nativeProbe` | A native payload reaches the intended backend path; portable fixtures cannot infer that path themselves. |
| Real services | [`backend-smoke.mjs`](../test/integration/backend-smoke.mjs), through the configured integration targets | The shared contracts run against those selected services and SDKs. Fake-client results alone are not service evidence. |

The contract already checks work draining at callback settlement, same-ID
operation ordering inside a transaction, callback error precedence, savepoint
isolation, and retained transaction handles after commit/rollback. These are
different from simultaneous transactions under a backend's isolation levels.
The [transaction/cache regressions](../test/transaction-cache-regression.test.ts)
also cover committed side-effect failures, caller-thrown committed-error
classes, and model rebinding; [cache coherence regressions](../test/cache-coherence-regression.test.ts)
cover shared cache identities and stale backfills. Their memory/fake-client
coverage must not be reported as a fresh real PostgreSQL concurrency run.

For each validation report, retain the exact commit, Node/SDK/service versions,
selected integration targets, exit status, and logs. Identify supported positive
checks, expected unsupported rejections, and unexecuted backends separately.
A job that never starts supplies no new execution evidence. A local run of
PostgreSQL does not establish MongoDB, Google emulator, distributed failover,
or production exactly-once behavior. Receipt/idempotency, crash recovery, and
query scan costs require their own designs and tests.

### Backend Coverage

The integration and release workflows require all ten configured targets to
finish; the runner rejects unknown targets and fails if any requested target is
missing from the completed set. Backend coverage is not interchangeable:

| Backend | Routine execution | Additional coverage and limits |
| --- | --- | --- |
| Memory store/cache/search | Real in-process implementations in the default suite | Shared contracts and core regressions; no distributed-service evidence. |
| SQLite | Real `node:sqlite` in the default suite, integration and release jobs | Temporary-file persistence, typed IDs/values, queries, aggregates, unique indexes, optimistic locking, transactions/savepoints, shared-connection ownership and independent-connection visibility. |
| PostgreSQL 16 | Real server in integration/release CI | Shared store contract, schema integrity, eight transaction outcome cases and twelve concurrency/cache cases described below. |
| MongoDB 7 | Real replica set in integration/release CI | Shared store/native paths, transactional bulk rollback and populated/empty aggregate aliases including `_id`. |
| Datastore | Official Google emulator in integration/release CI | Shared store/native paths, namespace/ancestor/key identity, ID repair, read policies, aggregates and Elasticsearch/outbox integration. Historical snapshots require a real service; emulator success does not establish production behavior. |
| Firestore | Official Google emulator in integration/release CI | Shared store/native paths, bulk rollback/codecs, typed min/max, sparse sum/avg/count, numeric validation and explicit aggregate scan opt-in. Production behavior is not established by emulator tests. |
| Redis 7 | Real server in integration/release CI | Shared cache contract. |
| Valkey 9.1.2 | Separate real server in integration/release CI | Shared cache contract, including TTL and versioned writes. `INFO server` must identify Valkey before cache operations; Redis cannot satisfy this target. |
| Elasticsearch 8.15.3 | Real server in integration/release CI | Shared search/native paths and Datastore outbox integration. |
| OpenSearch 3.9.0 | Real server in integration/release CI | Shared search/native paths, typed IDs, ancestor identity, projection, and seeded revision/tombstone/pagination fuzzing using the OpenSearch SDK. |
| Meilisearch CE 1.55.0 | Real server in integration/release CI | Shared search/native paths, successful task completion, typed IDs, ancestor identity, projection and seeded mutation fuzzing. Revision-ordered writes are explicitly unsupported. |
| Algolia | Injected SDK clients in the default suite | Shared search behavior; no live Algolia integration target. |

[`aggregate-parity.mjs`](../test/integration/aggregate-parity.mjs) adds focused
MongoDB and Firestore service regressions. The Firestore read counter wraps
actual SDK query objects; positive results come from the emulator, while the
counter proves rejected sum/avg operations make no reads without scan opt-in.
These tests do not establish distributed failover, production query costs or
load capacity.

The PostgreSQL target also runs
[`postgres-outcome.mjs`](../test/integration/postgres-outcome.mjs). Its eight
cases inspect durable rows through a separately reserved connection: confirmed
commit/rollback, a callback-created committed error, lost commit/rollback
acknowledgements, and release/afterCommit/cache failures after commit. The
acknowledgement and cleanup failures are injected by a test-owned client wrapper
after the real server responds. This supplies real row-state evidence for those
failure boundaries; it does not simulate network partitions, process crashes,
or database failover.

[`postgres-concurrency.mjs`](../test/integration/postgres-concurrency.mjs) adds
twelve PostgreSQL cases with explicitly ordered concurrent connections: stale
unversioned READ COMMITTED writes, optimistic version conflicts, REPEATABLE
READ/SERIALIZABLE update failures, statement/snapshot visibility, a row-lock
timeout, commit/rollback/unknown model lifetimes, shared-cache invalidation, and
same-ID isolation across schemas. Promise barriers order the schedules; the
lock test uses the database statement timeout while the owner retains its lock.
The test records the unversioned lost-update behavior as an explicit limitation,
not conflict-detection support. Raw external writes are checked with explicit
invalidation, and no distributed invalidation or automatic retry is assumed.

## Library Test Suite

For active-ts itself:

```sh
pnpm typecheck
pnpm test
```

The default suite uses memory adapters, the real built-in SQLite engine and
fake SDK clients. It does not require external services.

README and docs TypeScript/JavaScript fences must declare
`doc-test=typecheck` for standalone examples or `doc-test=fragment` for
contextual snippets. The test suite extracts standalone examples and compiles
them with the TypeScript compiler so documented imports and model APIs do not
drift silently.

Backend smoke coverage is available separately:

```sh
pnpm test:integration:backends
```

The GitHub `Backend Integration` workflow runs this script on schedule, manual
dispatch, main pushes, and pull requests that touch adapter, core, testing harness,
integration, package, or workflow files. It uses PostgreSQL, MongoDB,
Redis, Valkey, Elasticsearch, Meilisearch, and OpenSearch service containers, then starts Datastore and
Firestore emulators with Google Cloud CLI. The workflow pins the Elasticsearch
client to the same major as its service container, pins the Google Cloud SDK
used for emulator startup, waits for Datastore and Firestore SDK probes before
running contracts, and uses the lockfile-installed optional backend peers.
Focused smoke probes also exercise the real native callback handles for
MongoDB, Datastore, and Firestore by writing a row through active-ts and reading
it back through the adapter-provided backend handle. Datastore and Firestore
smoke also run focused aggregate checks against the Google emulators so SDK
aggregate helpers and typed `min`/`max` lookups stay covered. Elasticsearch
smoke also passes a contract `nativeProbe` that indexes a row and searches it
with a native-only query body against the service container.
