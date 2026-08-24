# active-ts

Active Record inspired TypeScript ORM for services that need pluggable stores,
batch caching, typed validation, explicit relation loading, and search adapters.

active-ts provides a batch-oriented data layer for services where a persistent
store, Redis/Valkey cache, and explicit object-graph loading need to work through
one model API. Relations, lazy references, and query/search adapters remain
explicit so applications can control data access and side effects.

## Status

This project is experimental. The core APIs are intentionally small and are still
expected to move while real applications exercise the adapter contracts.

## Features

- Active Record style `Model.find()`, `Model.where()`, `Model.search()`, single
  writes, and atomic lifecycle-aware model bulk APIs
- optimized query aggregates such as `count`, `sum`, `avg`, `min`, and `max`
- pluggable store adapters for Datastore, Firestore, MongoDB, PostgreSQL, and
  in-memory tests
- Redis/Valkey cache adapter with batch reads and negative cache entries
- search adapters for native store search, Algolia, Elasticsearch, and memory
- explicit `include()` relation loading with warned lazy relation fallback
- lifecycle hooks and plugins for validation, read/write, query, search,
  aggregate, cache, and relation-loading events
- model views and policies for application-facing serialization and permission
  checks
- function caches for Redis/Valkey-backed computed values
- cache codecs for extension-provided transforms such as Redis/Valkey
  encryption, compression, or tenant-specific serialization
- adapter middleware for retry, tracing, metrics, tenancy, and SDK-boundary
  policies
- field codecs, query scopes, query planner routes, transaction hooks, outbox
  events, and schema migration snapshots
- typia-compatible write validation and configurable read validation
- adapter contract tests and app-level test context helpers
- reserved-key and injection boundary checks for store/search adapters

## Installation

```sh
pnpm add active-ts
```

The examples use typia for runtime validation:

```sh
pnpm add typia
```

Install only the SDKs for the adapters your app uses:

```sh
pnpm add active-ts pg redis typia
pnpm add active-ts @google-cloud/datastore redis
pnpm add active-ts mongodb @elastic/elasticsearch
```

active-ts requires Node.js 22 or newer because it uses the platform
`structuredClone` implementation.

## Quick Example

```ts doc-test=typecheck
import typia from 'typia';
import {
	Model,
	MemoryCacheAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	createActiveTs,
	defineModel,
	createFunctionCache,
	setDefaultContext
} from 'active-ts';

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
	.view('summary', ({ data }) => ({ id: data.id, handle: data.handle }))
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

const context = createActiveTs({
	stores: { default: new MemoryStoreAdapter() },
	caches: { default: new MemoryCacheAdapter() },
	search: { memory: new MemorySearchAdapter() },
	defaultSearch: 'memory'
});

setDefaultContext(context);

const account = await Account.find(1).include('rank').load();
const rank = await account?.ref<Rank>('rank');

const count = await Account.where({ handle: ['startsWith', 'seo'] }).count();
const totalScore = await Account.query().sum('score');

const profileCache = createFunctionCache({
	prefix: 'profile',
	context,
	ttl: 300,
	factory: async (id: number) => {
		const rankRow = await Rank.find(id).load();
		return {
			id,
			rank: rankRow ? { rank: rankRow.data.rank, tier: rankRow.data.tier } : null
		};
	}
});

const profile = await profileCache.get(1);
```

## Datastore Sketch

Datastore-specific model metadata lives beside the normal Active Record model
definition, so ancestor keys, projected ancestor fields, and unindexed payload
fields stay visible to schema, query, search, and outbox paths:

```ts doc-test=typecheck
import { Model, datastoreKey, defineModel, type ActiveContext } from 'active-ts';
import { createDatastoreIndexYaml } from 'active-ts/adapters/store/datastore';

type CommentData = {
	id: number;
	postId: number;
	body: string;
	updatedAt: number;
};

class Comment extends Model<CommentData> {}
declare const context: ActiveContext;

defineModel<CommentData>({ name: 'comment', store: 'datastore' })
	.id('id')
	.validate((input) => input as CommentData)
	.fieldType('updatedAt', 'number')
	.index('updatedAt', { name: 'by_updated_at', directions: ['desc'] })
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('post', data.postId) : undefined,
		ancestorFields: ['postId'],
		unindexed: ['body']
	})
	.attach(Comment);

const postKey = datastoreKey('post', 1);
const ScopedComment = Comment.use(context) as typeof Comment;
await ScopedComment
	.under(postKey)
	.orderBy({ field: 'updatedAt', direction: 'desc' })
	.load();
const readTime = new Date('2026-07-17T00:00:00.000Z');
const historical = await ScopedComment
	.under(postKey)
	.readAt(readTime)
	.find(10)
	.load();
const indexYaml = createDatastoreIndexYaml(context.meta(Comment));
```

`readAt()` and `readConsistency()` map typed policies to Datastore point reads,
queries, and aggregates. Historical `find()` calls bypass entity caches, and
models loaded by `readAt()` are read-only so stale snapshots cannot be saved or
deleted accidentally. See
[Adapters](docs/adapters.md) for low-level `datastoreReadOptions()`, transaction
boundaries, and cursor guidance.

## Documentation

- [Quickstart](docs/quickstart.md) - install, define models, configure context,
  query data, and add validation
- [Core Concepts](docs/concepts.md) - models, contexts, relations, cache, query
  plans, schema sync, and validation modes
- [Lifecycle and Plugins](docs/plugins.md) - hooks, plugins, model views,
  policies, and function caches
- [Extension Points](docs/extensions.md) - adapter middleware, field codecs,
  query scopes, planner routing, transactions, outbox, and migration snapshots
- [Adapters](docs/adapters.md) - store/cache/search adapters, peer
  dependencies, native hooks, and adapter contracts
- [Testing](docs/testing.md) - app test contexts, fixture helpers, lazy-load
  warning assertions, and integration harnesses
- [Security Model](docs/security.md) - reserved keys, SQL safety, native escape
  hatches, and adapter-specific validation boundaries
- [Risk Register](https://github.com/seo-rii/active-ts/blob/main/docs/risk-register.md) - prioritized correctness,
  reliability, security, and release-readiness risks
- [Contributing](CONTRIBUTING.md) - development workflow and pull request
  expectations

## Adapter Matrix

| Layer | Built-in adapters |
| --- | --- |
| Store | memory, Datastore, Firestore, MongoDB, PostgreSQL |
| Cache | memory, Redis/Valkey |
| Search | memory, native store search, Algolia, Elasticsearch |

External SDKs are optional peer dependencies. The package can be installed with
no database SDKs when only memory adapters are used in tests.

## Safety Defaults

active-ts rejects data, query, and model fields named `__...`, `__proto__`,
`constructor`, or `prototype`. Adapter metadata uses symbols instead of special
string keys. For example, the Datastore adapter moves the Google Datastore key
symbol to `ACTIVE_TS_ENTITY_KEY`.

The common query DSL is the safe path. `native()` hooks are explicit raw escape
hatches and should only receive trusted query text or SDK payloads.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
```

The default test suite uses memory adapters and fake SDK clients, so it does not
require external services.

## License

MIT.
