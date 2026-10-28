# Datastore search identity migration

Context-managed Datastore search documents now include the physical project,
database, namespace, key encoding, full ancestor path, model kind, and typed ID
and the store cache scope (including backend endpoint identity) in their document identity. Root entities receive the same isolation as ancestor
entities. Adapters must expose `datastoreProjectId`, `datastoreDatabaseId` (`null`
for the default database), and `datastoreKeyEncoding`; unknown physical identity
fails before indexing or deleting. Ordinary non-Datastore adapters and direct
metadata calls with no physical scope retain their existing IDs.

Existing Datastore search document IDs change. Provision a new search index (or
prefix), rebuild it from the authoritative store using the updated context, and
switch consumers only after verifying the rebuilt results. Retire the old index
through the application's normal deployment procedure. This library does not
rewrite or remove existing external documents automatically.

Outbox events retain `modelDatastoreScope`, a canonical JSON tuple of project,
database, namespace, key encoding, and optional store cache scope. Workers compare it against their current
store before reading or writing. Drain old queues using the old application
before switching, or recreate pending events from their verified source store
with the new version. Do not merely add the scope to old `modelIdentity` values:
those identities also need regeneration. Repairs, retry snapshots, and revision
counter keys retain the full identity. Rebuild any persisted search cursors when
switching indexes.

Document identity prevents one physical entity from overwriting or deleting
another. A shared external search index still searches the documents selected by
its query; applications that need tenant-specific results should use dedicated
indexes or explicit search filters as part of their existing access policy.

A Datastore adapter may still use a client-local cache scope when an injected
client does not expose a complete physical endpoint. This remains valid for
entity-cache isolation, but the factory marks it as
`datastoreCacheScopeStability: 'client'` and durable search/outbox operations
reject it before indexing, deleting, or appending events. Configure the same
explicit `cacheScope` identifying the real project, database, namespace, key
encoding, and endpoint on every participating client. Known physical endpoints
and explicit scopes are marked `'stable'`; reconnecting then preserves document
IDs and allows another worker to deliver pending events. Custom adapters that
provide physical metadata without a stability marker retain their existing
caller-asserted identity contract.
