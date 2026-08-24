# Quickstart

This guide builds a small app using memory adapters. The same model definitions
work with Datastore, Firestore, MongoDB, PostgreSQL, Redis/Valkey, Algolia, and
Elasticsearch once those adapters are registered in the context.

## Install

```sh
pnpm add active-ts typia
```

For production adapters, install the matching SDKs:

```sh
pnpm add active-ts pg redis typia
pnpm add active-ts @google-cloud/datastore redis typia
pnpm add active-ts mongodb algoliasearch typia
```

active-ts requires Node.js 22 or newer.

## Define Models

```ts doc-test=typecheck
import typia from 'typia';
import { Model, defineModel } from 'active-ts';

type AccountData = {
	id: number;
	handle: string;
	name?: string;
	score?: number;
};

type RankData = {
	id: number;
	rank: number;
	tier: number;
};

class Account extends Model<AccountData> {}
class Rank extends Model<RankData> {}

defineModel<AccountData>({ name: 'account', cache: { ttl: 86_400 }, search: 'memory' })
	.id('id')
	.validate(typia.misc.createAssertPrune<AccountData>())
	.readValidation('warn')
	.index('handle', { unique: true })
	.search('memory', ['handle', 'name'])
	.view('summary', ({ data }) => ({ id: data.id, handle: data.handle, name: data.name }))
	.policy('editable', ({ data, viewer }) => (viewer as { id?: number } | undefined)?.id === data.id)
	.ref('rank', () => Rank, {
		localKey: 'id',
		foreignKey: 'id',
		preload: ['rank', 'tier']
	})
	.attach(Account);

defineModel<RankData>({ name: 'rank', cache: { ttl: 86_400 } })
	.id('id')
	.validate(typia.misc.createAssertPrune<RankData>())
	.attach(Rank);
```

## Configure a Context

The context owns adapters and model metadata resolution. Most apps install one
default context during boot.

```ts doc-test=typecheck
import {
	MemoryCacheAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	createActiveTs,
	setDefaultContext
} from 'active-ts';

const store = new MemoryStoreAdapter();

const context = createActiveTs({
	stores: { default: store },
	caches: { default: new MemoryCacheAdapter() },
	search: { memory: new MemorySearchAdapter() },
	defaultSearch: 'memory'
});

setDefaultContext(context);
```

## Create and Load Records

```ts doc-test=fragment
await Account.create({ id: 1, handle: 'seorii', name: 'Seorii' });
await Rank.create({ id: 1, rank: 10, tier: 4 });

const account = await Account.find(1).include('rank').load();
const rank = await account?.ref<Rank>('rank');

const summary = await account?.view('summary');
const editable = await account?.can('editable', { id: 1 });
```

`include('rank')` loads the relation intentionally. Accessing a relation without
`include()` still works, but active-ts emits a warning once per relation so
unexpected RTT-heavy code is visible.

## Query

```ts doc-test=fragment
const result = await Account.query()
	.where('handle', 'startsWith', 'seo')
	.orderBy({ field: 'name', direction: 'asc' })
	.limit(20)
	.load();

const first = await Account.where({ handle: 'seorii' }).first();
```

Supported operators are `=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `between`,
`arrayContains`, `textContains`, `jsonContains`, and `startsWith`.
The older `contains` spelling is intentionally rejected because it cannot mean
the same thing across all stores.
Adapters can reject operators they cannot implement with the same semantics.
For example, PostgreSQL JSON storage does not advertise portable containment
operators; use native SQL for backend-specific text or JSON containment.

Use `whereAny()` for OR groups. Earlier `where()` filters are copied into every
OR branch. `where().orWhere()` is rejected to avoid accidentally bypassing
shared filters:

```ts doc-test=fragment
await Account.query()
	.where('handle', 'startsWith', 'seo')
	.whereAny({ name: 'Seorii' }, { name: 'SEO Rii' })
	.load();
```

## Aggregate

Aggregate helpers run through the store adapter's native aggregate path when it
exists. Custom store adapters that omit `aggregate()` are rejected by default.
Enable `aggregate.allowQueryFallback: true` on the context only when you
intentionally want active-ts to run a filtered query and compute the aggregate in
memory.

```ts doc-test=fragment
const count = await Account.where({ handle: ['startsWith', 'seo'] }).count();
const totalScore = await Account.query().sum('score');
const averageScore = await Account.query().avg('score');
const highestScore = await Account.query().max('score');

const summary = await Account.query().where('score', '>=', 10).aggregate({
	count: 'count',
	totalScore: { op: 'sum', field: 'score' },
	highestScore: { op: 'max', field: 'score' }
});
```

Aggregate helpers apply `where()` and `whereAny()` filters. They intentionally do
not apply `include()`, `select()`, `orderBy()`, `cursor()`, or `limit()`.

## Search

```ts doc-test=fragment
const result = await Account.search('seo')
	.using('memory')
	.limit(10)
	.load();
```

Search adapters are configured separately from store adapters. Use `native()`
only for trusted search payloads.

## Add Hooks and Plugins

Use plugins for cross-cutting behavior such as audit, metrics, and tracing:

```ts doc-test=fragment
const context = createActiveTs({
	stores: { default: store },
	plugins: [
		{
			name: 'audit',
			hooks: {
				afterCreate: ({ model, id }) => audit(`${model?.name}:${id}:created`),
				afterQuery: ({ model, result }) => metrics.count(`${model?.name}.query`, result.list.length)
			}
		}
	]
});
```

Use model hooks for model-local normalization:

```ts doc-test=fragment
defineModel<AccountData>({ name: 'account' })
	.hooks({
		beforeValidate({ data }) {
			return { data: { ...data, handle: data.handle.trim().toLowerCase() } };
		}
	})
	.attach(Account);
```

## Cache Computed Values

```ts doc-test=fragment
import { createFunctionCache } from 'active-ts';

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

## Use a Production Store

```ts doc-test=fragment
import { createPostgresStoreAdapter } from 'active-ts/adapters/store/postgresql';
import { createRedisValkeyCacheAdapter } from 'active-ts/adapters/cache/redis-valkey';

const context = createActiveTs({
	stores: {
		default: await createPostgresStoreAdapter({
			connectionString: process.env.DATABASE_URL
		})
	},
	caches: {
		default: await createRedisValkeyCacheAdapter({
			url: process.env.REDIS_URL
		})
	}
});
```

For adapter-specific details, see [Adapters](adapters.md).
