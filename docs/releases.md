# Release artifacts and verification levels

Each release workflow packs once, tests that tarball in an installed consumer,
and retains it with `release-manifest.json`. The publish job downloads and verifies
the same bytes before `npm publish`; it does not rebuild from a second checkout.
The manifest records the Git commit/tree, package version, SHA-256, SHA-512 npm
integrity, byte count, Node/compiler/package-manager versions, module format and
peer ranges. A package version alone does not identify an unpublished local build.
Publishing an existing npm version still requires a new version; a manifest does
not permit replacing an immutable published version.

For a local review artifact outside the checkout:

```sh
node scripts/release-artifact.mjs create /absolute/release-directory
node scripts/release-artifact.mjs verify /absolute/release-directory
ACTIVE_TS_PACKAGE_TARBALL=/absolute/release-directory/active-ts-0.1.0.tgz pnpm pack:smoke
```

Local dirty builds are explicitly marked. The release workflow requires a clean
source tree and checks the manifest against `GITHUB_SHA` before promotion. The
manifest is an identity/checksum record, not a signature or a substitute for
trusted workflow execution. npm provenance remains enabled for publication.

| Level | What it establishes | What it does not establish |
| --- | --- | --- |
| Unit and mock suite | Key types, query rejection, codec limits, cache races, transaction/outbox lifecycles and partial failure contracts | Provider service behavior or runtime compatibility |
| Installed tarball smoke | Public ESM exports, declarations, Typed View inference and runtime APIs without source aliases or peer overrides | Production database permissions, credentials or indexes |
| Backend integration workflow | SDK operations against the configured emulators/disposable services | Production latency, consistency or billing |
| Application deployment gate | The application's exact SDK/compiler/transport/runtime combination | Other untested provider major versions |

The published API targets ESM and Node 22+. The repository lockfile is the source
of exact SDK and compiler versions exercised in CI; peer ranges are compatibility
constraints rather than evidence that every version has been tested. Portable
query capabilities remain adapter-specific. Unsupported OR, historical read or
projection combinations must fail explicitly; scan fallbacks remain opt-in.

Request batching and DTO projection do not establish a provider RPC or billing
budget. Measure RPC calls, returned entities/bytes, concurrency, cache hits,
outbox writes and search delivery in the target environment. Batch deduplication
belongs to the request context; do not reuse viewer or transaction state across
requests. Durable operation receipts, retention and multi-database compensation
remain application policy.

Before existing data is written, preserve its native key encoding, configure
namespace/database boundaries and explicit index exclusions, and select a new
versioned cache prefix. Coordinate external writers with invalidation. Treat
read-time queries as historical reads with a cache bypass, and search hits as
candidates requiring authoritative source/permission checks before DTO conversion.
