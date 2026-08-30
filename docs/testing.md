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

## Library Test Suite

For active-ts itself:

```sh
pnpm typecheck
pnpm test
```

The default suite uses memory adapters and fake SDK clients, so it is fast and
does not require external services.

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
Redis/Valkey, and Elasticsearch service containers, then starts Datastore and
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
