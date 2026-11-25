# Function cache diagnostics

`cache.diagnostics()` returns an independent snapshot with no cached values or
logical keys. It reports memory and in-flight entry counts, failed-key bypasses,
distributed recovery attempts, and backfills rejected because of changed local
epochs, missing distributed versions, or remote version conflicts. Counters are
cumulative for that function-cache instance.

`adapterFailedKeys` counts the protected keys on its persistent adapter. This is
shared with other function-cache instances using the same adapter, so it should
not be summed across those instances. A recovered key disappears from this count.
Failure tracking is bounded: after more than 4096 failed keys on one adapter,
`adapterFailureOverflow` becomes `true` and every key on that adapter that has not
been individually refreshed or invalidated since is protected, while
`adapterFailedKeys` counts only failures recorded after the overflow.

The existing `getFunctionCacheDiagnostics()` also reports
`pendingInvalidationKeys` alongside the bounded invalidation epoch map size.
These snapshots do not initiate I/O or retain a global list of live adapters.

Memory, codec, and Redis cache adapters share batch/key and write-option input
normalization. Each complete batch is validated before codec calls or backend
mutations; adapter-specific value encoding, TTL rules, and Unicode requirements
remain at their respective boundaries.
