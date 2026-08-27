# Core Concepts

active-ts keeps the public API small. The important pieces are models, model
metadata, contexts, adapters, relations, and query plans.

active-ts is an ESM-only Node.js package. Consumers must use `import` or dynamic
`import()`; CommonJS `require()` is intentionally outside the package contract.

## Model

Models extend `Model<TData>` and wrap a plain data object:

```ts doc-test=fragment
class Account extends Model<AccountData> {}

const account = await Account.find(1).load();
console.log(account?.data.handle);
console.log(account?.id);
```

The base model exposes static helpers:

- `find(id)` - batched id lookup through cache and store
- `query()` / `where(shape)` - structured store query
- `search(text)` - search adapter query
- `create(data)` / `update(id, patch)` / `delete(id)` - single-row writes
- `createMany(data)` / `upsertMany(data)` / `deleteMany(ids)` - atomic,
  lifecycle-aware bulk writes
- `count()`, `sum(field)`, `avg(field)`, `min(field)`, and `max(field)` -
  optimized aggregate helpers

## Model Metadata

`defineModel()` attaches runtime metadata to a model class:

```ts doc-test=fragment
defineModel<AccountData>({ name: 'account', cache: { ttl: 60 }, search: 'algolia' })
	.id('id')
	.index('handle', { unique: true })
	.search('algolia', ['handle', 'name'])
	.attach(Account);
```

Metadata defines the external collection/table name, id field, validation,
indexes, search indexes, cache policy, and relation graph.
Store indexes can declare per-field directions with `directions`, for example
`index('score', { fields: ['ownerId', 'score'], directions: ['asc', 'desc'] })`.

Metadata can also define model-local hooks, views, and policies:

```ts doc-test=fragment
defineModel<AccountData>({ name: 'account' })
	.id('id')
	.view('summary', ({ data }) => ({ id: data.id, handle: data.handle }))
	.policy('editable', ({ data, viewer }) => (viewer as User).id === data.ownerId)
	.hooks({
		beforeValidate(payload) {
			return { data: { ...payload.data, handle: payload.data.handle.trim() } };
		}
	})
	.attach(Account);
```

Scopes and field codecs are also model metadata. Scopes add reusable query
filters, while field codecs transform selected fields as data crosses the store
boundary:

```ts doc-test=fragment
defineModel<DocumentData>({ name: 'document' })
	.scope('visibleTo', ({ viewer }) => ({ tenantId: (viewer as User).tenantId }))
	.fieldCodec('privateNote', encryptedStringCodec)
	.fieldType('publishedAt', 'date')
	.attach(Document);
```

`fieldType('...', 'date')` stores the field as a canonical ISO string and
hydrates it back to a `Date` on reads. Date query operands are normalized the
same way so memory and JSON-backed adapters compare the same values.

Field codecs are not queryable by default because the stored representation may
not preserve portable comparison semantics. If a codec is deterministic and
safe to filter on, provide `encodeQuery(value, context)` alongside `encode` and
`decode`; otherwise `where()` and search filters on that field fail fast. By
default codec queries allow equality-style operators (`=`, `!=`, and `in`).
Operators such as `startsWith`, range comparisons, and text or JSON containment
must be listed in `queryOperators` only when the encoded representation preserves
that operator's semantics. `encodeQuery` receives `context.operator` for those
cases.

## Context

An `ActiveContext` owns the registered adapters:

```ts doc-test=fragment
const context = createActiveTs({
	stores: { default: store },
	caches: { default: cache },
	search: { default: search },
	lazyWarnings: true,
	schema: { autoSync: 'safe' }
});
```

`setDefaultContext(context)` installs it for the static model APIs. Tests can use
`withTestContext()` to install a temporary context and restore the previous one.

Plugins are registered on the context and run before model-local hooks:

```ts doc-test=fragment
const context = createActiveTs({
	stores: { default: store },
	plugins: [
		{
			name: 'audit',
			hooks: {
				afterUpdate: ({ model, id }) => audit(`${model?.name}:${id}`)
			}
		}
	]
});
```

Contexts can route work through a query planner:

```ts doc-test=fragment
const context = createActiveTs({
	stores: { primary, replica },
	search: { shortSearch, longSearch },
	queryPlanner: {
		routeQuery: () => 'replica',
		routeAggregate: () => 'primary',
		schemaSearchAdapters: ['shortSearch', 'longSearch'],
		routeSearch: ({ query }) => (query.length < 3 ? 'shortSearch' : 'longSearch')
	}
});
```

## Batch Loading and Cache

`Model.find(id).load()` goes through a per-model batch loader. Loads scheduled in
the same event-loop turn are coalesced into one `getMany()` store call.
Large batches are chunked before cache/store adapters see them. The default
chunk size is `500`; set `batch.maxSize` on the context when a backend has a
lower request limit.

When a model has cache metadata, active-ts checks the cache before the store and
writes loaded rows back with the configured TTL.

```ts doc-test=fragment
defineModel<AccountData>({ name: 'account', cache: { ttl: 86_400 } })
	.id('id')
	.attach(Account);
```

Cache keys are derived from model name and id. Cache adapters implement
`getMany()`, `setMany()`, and `deleteMany()`.

For computed values, use a function cache. It keeps a small in-process memo and
can also use the registered cache adapter, so Redis/Valkey still handles shared
cache state across processes:

```ts doc-test=fragment
const profileCache = createFunctionCache({
	prefix: 'profile',
	context,
	ttl: 300,
	key: (id: number) => `account:${id}`,
	factory: async (id: number) => buildProfile(id)
});

const profile = await profileCache.get(1);
await profileCache.invalidate(1);
```

## Relations

Relations are declared as metadata and loaded explicitly:

```ts doc-test=fragment
defineModel<AccountData>({ name: 'account' })
	.id('id')
	.ref('rank', () => Rank, {
		localKey: 'id',
		foreignKey: 'id',
		preload: ['rank', 'tier']
	})
	.attach(Account);

const account = await Account.find(1).include({ rank: true }).load();
const rank = await account?.ref<Rank>('rank');
```

If a relation is accessed without `include()`, active-ts loads it lazily and logs
a warning once per relation by default. Use this as a guardrail against
accidental RTT growth.

`include()` accepts dotted paths and object notation, and list queries batch
foreign-key relation preloads with a single `in` query when the adapter supports
the shared operator:

```ts doc-test=fragment
await Account.query().include({ posts: { comments: 'author' } }).load();
```

Relation `preload` fields are translated into `select()` projections for both
lazy and batched relation loads. active-ts also includes the target id and
foreign key so relation matching remains stable.

Decorator relation getters are supported:

```ts doc-test=fragment
class Account extends Model<AccountData> {
	@ref(() => Rank, { localKey: 'id', foreignKey: 'id' })
	declare rank: LazyRef<Rank>;
}
```

Use `declare` so TypeScript does not emit a class field that shadows the getter.

## Query Plans

The query builder produces a `QueryPlan` consumed by the active store adapter.
Adapters translate the shared operators to their native backend.

```ts doc-test=fragment
await Account.query()
	.where('handle', '=', 'seorii')
	.whereAny({ name: ['startsWith', 'Seo'] }, { handle: 'seo' })
	.orderBy('-id')
	.select('id', 'handle')
	.offset(20)
	.limit(10)
	.load();
```

The common DSL validates field paths, limits, and offsets before reaching adapters.
`offset()` accepts a non-negative safe integer and is supported by every built-in
store adapter. Apply an explicit `orderBy()` whenever page boundaries must be
repeatable. Offset pagination cannot be combined with `cursor()` pagination.
Prefer cursors for long scans and deep pages: offset-backed stores still have to
scan or account for skipped rows, and Datastore and Firestore can bill those
skipped document reads.
Use explicit containment operators: `arrayContains`, `textContains`, and
`jsonContains`. The legacy `contains` operator is rejected because it is
ambiguous across document, relational, and search backends.
Portable `textContains` is case-insensitive and matches scalar strings or
string-array elements; use `arrayContains` for exact array membership.
`select()` returns partial model instances: active-ts always includes the
model id field in the projection and skips full read validation for projected
rows because non-selected required fields may be absent. Partial instances are
read-only ORM objects: `save()`, `include()`, `ref()`, views, and policies fail
fast so projected rows cannot accidentally replace full records with missing
fields. The TypeScript type mirrors this: selected fields are present on
`data`, non-selected fields are optional, and full-model operations are not
callable on the projected result.

Use `whereAny()` for explicit OR groups. Chaining `where().orWhere()` is rejected
because it is too easy to accidentally weaken tenant or visibility predicates.
Named `scope()` filters and prior `where()` filters are treated as global
constraints and are copied into every `whereAny()` branch.

## Aggregates

Query builders expose aggregate helpers:

```ts doc-test=fragment
await Account.query().count();
await Account.query().sum('score');
await Account.query().avg('score');
await Account.query().min('score');
await Account.query().max('score');

await Account.query().aggregate({
	count: 'count',
	totalScore: { op: 'sum', field: 'score' },
	maxScore: { op: 'max', field: 'score' }
});
```

Aggregates are automatically optimized when the active store adapter implements
`aggregate()`. PostgreSQL uses SQL aggregates, MongoDB uses aggregation
pipelines for `count`, `sum`, and `avg`, Datastore and Firestore use aggregate
queries for `count`, `sum`, and `avg`, and memory uses its in-process index.
Datastore and Firestore can use typed ordered lookups for `min`/`max`. Built-in
adapter paths that need a validated projection scan, such as MongoDB
`min`/`max`, Firestore aggregates without an SDK helper or typed `min`/`max`
lookup, or a Datastore emulator-safe full-row aggregate scan, require that
adapter's `allowAggregateScanFallback: true` option.
Datastore's `allowQueryScanFallback: true` option is a separate dev/test escape
hatch for legacy Datastore emulator query gaps such as `!=`, `isNotNull`, and
`IN`; it scans the kind and applies portable filtering in process.
Adapters without aggregate support fail fast by default so helper calls do not
accidentally full-scan a collection. Set `aggregate.allowQueryFallback: true`
on the context only when a filtered `query()` fallback is acceptable for that
environment.

Aggregates apply filters from `where()` and `whereAny()`. They ignore relation
includes, ordering, cursor, offset, select, and limit because those are list-shaping
operations rather than aggregate filters.

## Search

Search is separate from store queries:

```ts doc-test=fragment
await Account.search('seorii')
	.using('elasticsearch')
	.limit(10)
	.load();
```

Search adapters return projected search documents: the model id plus fields
declared in the matching search index. `load()` instantiates those hits as
partial model instances. Field type hydration still runs, but full read
validation, `save()`, relation refs, views, and policies are intentionally
blocked on partial hits.
The portable memory search adapter and the native search adapter over stores
that implement active-ts `textContains` use case-insensitive text matching for
string fields and string-array elements. Remote adapters still depend on their
backend analyzer configuration.

Use `include(...)` on the search builder when you need relations or full model
behavior. In that path active-ts reads the hit ids back from the store, validates
the full rows, and then preloads the requested relations. Stale search hits that
no longer exist in the store are dropped; `count` reflects the live rows returned
on that page, `more` and `cursor` remain search-index continuation metadata, and
`total` is cleared when stale hits were pruned because an exact live total is no
longer known.

## Views and Policies

Views are named serializers. They keep API output shaping near the model
metadata without forcing every model instance to expose public data directly.

```ts doc-test=fragment
const summary = await account.view('summary');
```

Policies are named permission checks:

```ts doc-test=fragment
if (await account.can('editable', currentUser)) {
	await account.save();
}
```

Both receive `{ context, model, data, viewer }`. Views also receive `name`;
policies receive `policy`.

## Lifecycle Hooks

Hooks can be registered by plugins or by model metadata. Plugin hooks run first,
then model hooks. Hook payloads are mutable and can also return a partial payload
override.

Supported hooks cover validation, reads, instantiation, create/update/delete,
query/search/aggregate, cache get/set/invalidate, indexing, and relation loading:

```ts doc-test=fragment
defineModel<AccountData>({ name: 'account' })
	.hooks({
		beforeCreate({ data }) {
			return { data: { ...data, createdAt: new Date().toISOString() } };
		},
		afterQuery({ model, result }) {
			metrics.increment(`${model?.name}.query`, result.list.length);
		}
	})
	.attach(Account);
```

`beforeValidate` is the right place to normalize user input before the validator
runs. `afterValidate` observes the pruned value that will be written.

## Validation

Write validation is configured with any function shaped like
`(input: unknown) => TData`. typia's `createAssertPrune<T>()` works well:

```ts doc-test=fragment
defineModel<AccountData>({ name: 'account' })
	.id('id')
	.validate(typia.misc.createAssertPrune<AccountData>())
	.readValidation('warn')
	.attach(Account);
```

Read validation modes:

- `off` - skip validator on reads
- `warn` - warn and return raw data if validation fails
- `error` - throw if validation fails

Reserved keys are checked before writes and before model instantiation even when
read validation is off.

## Schema Sync

Store adapters may expose schema planning and safe application:

```ts doc-test=fragment
const plans = await context.schemaPlan([Account, Rank]);
await context.schemaApply([Account, Rank]);
```

`schema.autoSync: 'safe'` allows adapters to create missing collections/tables
and indexes. Destructive changes are intentionally out of scope.

`schemaMigration(models, name)` captures the same plans as a migration snapshot
without applying them.
