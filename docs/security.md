# Security Model

active-ts favors validation and explicit trust boundaries over lossy sanitizers.
Unsafe inputs should fail before reaching database SDKs.

## Reserved Keys

The following field names are rejected in data, query paths, model metadata, and
adapter calls:

- names beginning with `__`
- `__proto__`
- `constructor`
- `prototype`

These names are blocked to avoid prototype pollution and collisions with backend
metadata conventions.

Datastore metadata is exposed through `ACTIVE_TS_ENTITY_KEY`, a symbol, rather
than through a reserved string property.

## Clone and Validation

`cloneSafeData()` validates supported value types, reserved keys, accessor
properties, and symbol metadata before it calls the platform `structuredClone`
implementation. active-ts does not maintain a custom deep-clone sanitizer, but
it fails fast before clone boundaries that would otherwise drop fields or throw
platform-specific errors.

The only data symbol metadata active-ts preserves is non-enumerable
`ACTIVE_TS_ENTITY_KEY`, used by the Datastore adapter for SDK entity keys.
Enumerable caller-supplied symbol fields are rejected instead of being silently
dropped.

Read paths validate raw records before model instantiation. Write paths validate
data before adapter calls. Query builders validate field paths and limit values
before producing adapter plans.

## SQL Safety

The PostgreSQL adapter treats the shared query DSL as the safe path:

- ids and query values are SQL parameters
- JSON field paths in `where` and `orderBy` are passed as `text[]` parameters
- schema, table, and index identifiers are escaped with `pg-format`
- JSON path literal segments used for schema index DDL are escaped with
  `pg-format`
- JSON field paths use the shared active-ts field-path validator, so reserved
  `__*`/prototype keys and empty path segments are rejected before SQL planning

`native()` is not sanitized:

```ts doc-test=fragment
Account.query().native({
	text: 'select data from "account" where id = $1',
	values: ['1']
});
```

Only pass trusted SQL text to `native()`. Keep user-provided values in parameter
arrays.

## Adapter Boundaries

Adapters enforce backend-specific constraints before calling SDKs:

- MongoDB rejects `$` fields, invalid collection/index names, invalid limits,
  and reserved payload keys. `startsWith` regex prefixes are escaped with
  `escape-string-regexp`.
- Firestore rejects slash-containing collection, document, and field paths,
  invalid limits, and reserved payload keys.
- Datastore rejects slash-containing field paths and reserved query/data keys,
  and maps datastore key metadata to a symbol.
- Algolia and Elasticsearch reject invalid index/search metadata, invalid
  limits, and reserved indexed documents.

## Cache Payloads

Redis/Valkey payload encryption is modeled as a cache codec extension. The
built-in AES-GCM codec uses Node's `crypto` module and authenticates payloads
before decoding them. Applications are responsible for key management, rotation,
and deciding whether cache keys themselves need tenant-specific namespacing. AES
keys must be exactly 32 random bytes; decode environment values from a binary
encoding such as base64url before passing them to the codec.

```ts doc-test=fragment
const cacheKey = Buffer.from(process.env.CACHE_ENCRYPTION_KEY!, 'base64url');
const cache = await createRedisValkeyCacheAdapter({
	url: process.env.REDIS_URL,
	codec: createAesGcmCacheCodec({ key: cacheKey })
});
```

## Reporting Security Issues

Report suspected vulnerabilities through GitHub private vulnerability reporting.
Do not open public issues for suspected vulnerabilities until a fix or advisory
is available.
