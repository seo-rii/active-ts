# Lifecycle and Plugins

active-ts exposes lifecycle hooks in two places:

- plugins registered on `createActiveTs({ plugins })`
- model metadata registered with `defineModel().hooks(...)`

Plugin hooks run first. Model hooks run after them. A hook can mutate the payload
object or return a partial payload to merge into the current payload. The outbox
plugin is a reserved exception for post-write lifecycle hooks: it snapshots
committed events before ordinary `afterCreate`, `afterUpdate`, and `afterDelete`
hooks, and active-ts rejects later post-write mutations to committed model data.

## Plugin

```ts doc-test=fragment
import { createActiveTs } from 'active-ts';

const context = createActiveTs({
	stores: { default: store },
	caches: { default: cache },
	plugins: [
		{
			name: 'audit',
			hooks: {
				afterCreate({ model, id }) {
					audit.write(`${model?.name}:${id}:created`);
				},
				afterUpdate({ model, id }) {
					audit.write(`${model?.name}:${id}:updated`);
				}
			},
			setup(context) {
				metrics.register('active_ts_context', context);
			}
		}
	]
});
```

`setup()` is for installing side effects such as metrics, tracing, or adapter
wrappers. Synchronous setup errors fail `createActiveTs()`. If setup is async,
await `context.ready()` before serving traffic, or construct the context with
`await createActiveTsAsync(...)` so setup failures fail fast. Hooks are the
preferred extension point for request-visible behavior.

## Model Hooks

```ts doc-test=fragment
defineModel<AccountData>({ name: 'account' })
	.id('id')
	.hooks({
		beforeValidate({ data }) {
			return { data: { ...data, handle: data.handle.trim().toLowerCase() } };
		},
		afterQuery({ result }) {
			result.count ??= result.list.length;
		}
	})
	.attach(Account);
```

Use `beforeValidate` to normalize data before typia or another validator runs.
Use `afterValidate` for audit and metrics that need the pruned write payload.

## Hook Names

The current hook names are:

- `beforeValidate`, `afterValidate`
- `beforeRead`, `afterRead`, `afterInstantiate`
- `beforeCreate`, `afterCreate`
- `beforeUpdate`, `afterUpdate`
- `beforeDelete`, `afterDelete`
- `afterStoreWrite`
- `beforeQuery`, `afterQuery`
- `beforeAggregate`, `afterAggregate`
- `beforeSearch`, `afterSearch`
- `beforeIndex`, `afterIndex`
- `beforeCacheGet`, `afterCacheGet`
- `beforeCacheSet`, `afterCacheSet`
- `beforeCacheInvalidate`, `afterCacheInvalidate`
- `beforeRelationLoad`, `afterRelationLoad`

Hook payloads include `context`, and may include `model`, `target`, `id`, `ids`,
`data`, `patch`, `plan`, `query`, `options`, `result`, `operation`, and `meta`
depending on the event.

Hooks can return a partial payload to replace supported values. The core consumes
returned `data` from `beforeValidate`, `afterValidate`, and `beforeCacheSet`;
returned `plan` from `beforeQuery` and `beforeAggregate`; returned `query` and
`options` from `beforeSearch`; and returned `result` from `afterRead`,
`afterCacheGet`, `afterQuery`, `afterAggregate`, and `afterSearch`. Cache set
hooks receive `ids` aligned to the `data` entries being written, so positive
and negative cache writes are reported as separate payloads.

`afterStoreWrite` runs after the persistence boundary accepts a create, update,
or delete and before ordinary post-write hooks. It also runs for an id-based
static update or delete whose read confirms the entity is already absent; that
case has `payload.meta.storeWrite === false` and `committedAbsence === true`.
Active-ts starts this observer boundary alongside entity-cache invalidation.
Every `afterStoreWrite` hook starts with an independent payload container, so a
pending or failed observer cannot prevent another observer from starting;
return values are not carried to other hooks.
In a transaction the operation is not committed yet, so hooks that contact an
external system must register that work with `context.afterCommit()`.

## Views

Views are named serializers attached to model metadata.

```ts doc-test=fragment
defineModel<AccountData>({ name: 'account' })
	.view('summary', ({ data }) => ({
		id: data.id,
		handle: data.handle
	}))
	.attach(Account);

const summary = await account.view('summary');
```

Views keep public API shapes in metadata while allowing the model class to stay
small.

## Policies

Policies are named permission checks attached to model metadata.

```ts doc-test=fragment
defineModel<AccountData>({ name: 'account' })
	.policy('editable', ({ data, viewer }) => data.ownerId === (viewer as User).id)
	.attach(Account);

if (await account.can('editable', currentUser)) {
	await account.save();
}
```

Policies return booleans and can be asynchronous.

## Outbox Plugin

The outbox plugin turns model lifecycle events into durable messages. It writes
after transaction commit when `context.transaction()` is active.

```ts doc-test=fragment
const outbox = new MemoryOutboxAdapter();

const context = createActiveTs({
	stores: { default: store },
	plugins: [createOutboxPlugin({ outbox, includeData: true })]
});
```

Production systems should provide an `OutboxAdapter` backed by a table or
collection and have workers drain it for search indexing, webhooks, or pub/sub.
For Datastore-backed transactions, use an adapter with `appendTransactional()`
such as `StoreOutboxAdapter`; deferred non-transactional appends are rejected by
default because commit failures can leave the transaction outcome unknown.
For `runSearchSyncWorker()`, prefer `lease()/ack()/isLeaseCurrent()`. Custom
`drain()` adapters must also implement ordered `requeue(events)` so failed
deliveries return ahead of newer events. Pass `batchSize` to bound each worker
run; custom `lease()` and `drain()` adapters should honor the `{ limit }` option
they receive from the worker. When an adapter exposes `lease()` but reports that
exclusive leases are unavailable, the worker refuses to fall back to
`drain()/requeue()` unless `allowUnsafeDrainFallback: true` is passed.
`StoreOutboxAdapter` uses optimistic locking when available and otherwise uses
transaction-backed lease claims, releases, and acknowledgements, including on
Datastore. A custom store may use that fallback only when it advertises both
`transaction: true` and `transactionConflictDetection: true`; the latter promises
that a concurrent write after a transactional point read aborts one commit.
When a model store exposes `datastoreProjectId`, `createOutboxPlugin()` records
it as `modelDatastoreProjectId`. The search worker verifies that value against
the supplied context before resolving routes or mutating an index. Legacy or
manually produced events without the field remain accepted; producers that know
their project should always include it.

## Function Cache

`createFunctionCache()` provides the `Cache<TInput, TValue>` style abstraction:
an input is mapped to a stable cache key, a factory computes misses, and the
result is stored in both a process-local memo and the configured cache adapter.

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

The function cache runs the same cache hooks as model cache reads and writes.
Use `refresh: true` to bypass both cache layers and recompute:

```ts doc-test=fragment
const fresh = await profileCache.get(1, { refresh: true });
```

## Cache Codecs

Cache codecs let extensions transform values at the cache boundary. Encryption,
compression, and tenant-specific serialization should live here instead of being
hard-coded into model loading or the Redis adapter.

Use a codec as a generic wrapper around any cache adapter:

```ts doc-test=fragment
const cacheKey = Buffer.from(process.env.CACHE_ENCRYPTION_KEY!, 'base64url');

const encryptedCache = createCodecCacheAdapter(
	redisCache,
	createAesGcmCacheCodec({ key: cacheKey })
);

const context = createActiveTs({
	stores: { default: store },
	caches: { default: encryptedCache }
});
```

Redis/Valkey can also receive a codec directly so encoded payloads are written
to Redis without an extra JSON serialization layer:

```ts doc-test=fragment
const cache = await createRedisValkeyCacheAdapter({
	url: process.env.REDIS_URL,
	codec: createAesGcmCacheCodec({
		key: cacheKey,
		aad: 'active-ts-cache'
	})
});
```

A custom extension only needs `encode()` and `decode()`:

```ts doc-test=fragment
const codec = {
	name: 'my-codec',
	async encode(value, { key }) {
		return encryptForKey(key, JSON.stringify(value));
	},
	async decode(value, { key }) {
		return JSON.parse(await decryptForKey(key, value));
	}
};
```
