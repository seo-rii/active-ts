# Indexed pending outbox delivery

Status: proposed. This document specifies a storage migration and implementation;
the current adapter continues to read the complete ordered event stream.

`StoreOutboxAdapter.lease()` loads events ordered by creation time, sequence and
id, then skips events with `deadLetteredAt`. Keeping many dead letters causes
each new delivery batch to read the same discarded rows. Merely filtering for a
missing `deadLetteredAt` is not portable: some stores do not match missing
properties with null predicates.

## Storage contract

Persist a required internal `deliveryState` beside each stored event, with exactly
two values: `pending` and `dead-letter`. Derive it from `deadLetteredAt` when
writing the stored envelope. Do not accept a caller-supplied state independently
of that timestamp, and do not add the internal field to the public event payload.

Every transition that currently changes dead-letter metadata must update both
fields in one atomic row mutation:

| Mutation | Resulting state |
| --- | --- |
| Append or requeue a live event | `pending` |
| Mark an event as dead letter | `dead-letter` |
| Replay a dead letter | `pending`, with dead-letter metadata removed |
| Lease, release or retry a live event | Retain `pending` |
| Acknowledge or discard | Remove the row |

Use the existing optimistic version or conflict-detecting transaction when an
operation derives its next state from the current row. A state/version conflict
must reject without leaving the timestamp and state inconsistent.

## Query and ordering contract

Add an index over `deliveryState, createdAt, sequence, id`, with ascending sort
directions. Keep the current physical event identity and ordering keys.

After migration, `lease()` and `drain()` query `deliveryState = 'pending'` and
consume continuation pages until their requested batch is filled or the query
is exhausted. `listDeadLetters()` queries `deliveryState = 'dead-letter'`.
Filtering must not exclude active leases, future retry times or earlier pending
events: these rows still block later events for the same entity. Existing
per-entity order checks therefore run over every pending row encountered, even
when the row cannot itself be delivered yet.

Pagination must be fixed before enabling the index. In particular, an empty page
after availability filtering does not establish that the pending queue is empty.
Retain the existing cursor-progress validation rather than implementing an
independent pagination loop.

## Migration and mixed-version writers

1. Ship envelope writers that materialize `deliveryState`, while readers retain
   the old ordered scan. Creation and every dead-letter/replay transition must
   write the new field before the backfill starts.
2. Ensure all writers have this implementation. An older writer can still
   create a row without the new field, so an index-ready marker alone cannot
   make mixed-version writers safe.
3. Backfill missing state in bounded pages. Preserve event id, creation time,
   sequence, lease, retries and public event data. Compare versions before each
   update, re-read conflicts and derive state from the latest timestamp. Do not
   offer a live backfill on stores without optimistic locking or conflict-
   detecting transactions; require an application-owned write pause instead.
4. Create and verify the composite index through schema planning. Index creation
   and data migration are distinct operations and require the application's
   normal infrastructure authorization.
5. Perform a final bounded inventory of missing or inconsistent state after old
   writers are stopped. Explicitly enable indexed reads only after this check.
   Keep scan mode available as a rollback option while both writer versions and
   schema readiness are operationally verified.

Do not silently enable indexed reads when a schema plan merely reports an index:
the data backfill and writer-version prerequisites are also necessary. A failed
backfill must leave scan mode usable and preserve all events.

## Required validation

- Compare indexed and scan-mode batches for the same queue, including leases,
  retry delays, descendant Datastore identities, same-entity ordering and
  continuation pages containing no immediately deliverable events.
- Seed a large dead-letter prefix and record rows fetched, pages and delivered
  events. Indexed mode must avoid fetching that prefix while returning the same
  live batch. Verify an actual execution plan for SQL stores.
- Inject failure into dead-letter and replay transitions. The stored timestamp
  and materialized state must remain consistent after failure or conflict.
- Interleave a backfill page with append, dead-letter, replay and acknowledgement.
  Version conflicts must neither lose a live event nor resurrect a removed row.
- Verify old-writer detection and readiness checks prevent enabling indexed
  reads prematurely, and that migration interruption leaves scan mode correct.

This proposal deliberately requires explicit migration readiness. Changing the
runtime predicate immediately would silently omit every existing sparse row.
