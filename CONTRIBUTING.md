# Contributing

Thanks for improving active-ts. This project is still experimental, so small,
well-tested changes are preferred over broad refactors.

## Development Setup

```sh
pnpm install
pnpm typecheck
pnpm test
```

The test suite is intentionally local by default. It uses memory adapters and
fake SDK clients unless a test explicitly opts into an external service.

## Project Layout

```text
src/core/          model, context, query, metadata, relation, validation code
src/adapters/      store/cache/search adapters
src/testing/       test contexts, fixtures, contracts, integration harnesses
test/              active-ts library tests
examples/          runnable examples
docs/              user-facing documentation
```

## Dependency Boundary

active-ts is consumer-agnostic. Application-specific compatibility code,
migration protocols, cache-key formats, schemas, and operational procedures
belong in the consuming application or a separate downstream package. The
library may expose generic extension points needed by those integrations, but
must not name or encode a particular consumer's behavior.

## Pull Request Expectations

- Keep the public API small and consistent with existing model/query patterns.
- Prefer adapter-local behavior over adding core abstractions unless multiple
  adapters need the same contract.
- Add tests for user-facing behavior, safety boundaries, and adapter contracts.
- Document new public APIs in `README.md` or `docs/`.
- Run `pnpm typecheck` and `pnpm test` before submitting.

## Adapter Contributions

New adapters should implement the relevant contract:

- store adapters implement `get`, `getMany`, `query`, `create`, `update`, and
  `delete`
- cache adapters implement `getMany`, `setMany`, and `deleteMany`
- search adapters implement `search`, `index`, and `delete`

Store adapters should pass:

```ts
await runStoreAdapterContract(adapter);
```

Adapter code should validate native backend constraints before calling SDKs and
should keep raw escape hatches explicit.

## Documentation Style

Write docs for users who are deciding whether to adopt the library:

- show complete imports in examples
- describe safety boundaries directly
- call out experimental or unsupported behavior
- keep backend-specific setup in adapter docs

## License

active-ts is licensed under the MIT License. Keep new contributions compatible
with that license.
