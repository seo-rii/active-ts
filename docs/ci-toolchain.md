# Locked package-manager bootstrap

The ORM and consumer use a reviewed pnpm 11.28.2 installation without running an
older pnpm as a bootstrap. This changes CI tooling, not the ORM runtime, schema,
public API or dependency graph in pnpm-lock.yaml.

## Two distinct findings

The previous pinned pnpm/action-setup action embeds pnpm 11.7.0 and runs it before
self-updating to its requested version. The embedded [lockfile](https://github.com/pnpm/action-setup/blob/0ebf47130e4866e96fce0953f49152a61190b271/src/install-pnpm/bootstrap/pnpm-lock.json)
and [installer](https://github.com/pnpm/action-setup/blob/0ebf47130e4866e96fce0953f49152a61190b271/src/install-pnpm/run.ts)
establish this sequence. Changing only with.version leaves that first stage.

The isolated registry/lockfile investigation on 2026-10-10 identified one affected
package with four advisories, not one advisory:

- [GHSA-qrv3-253h-g69c](https://github.com/pnpm/pnpm/security/advisories/GHSA-qrv3-253h-g69c), configDependencies path traversal; patched in 11.8.0.
- [GHSA-vx52-2968-3vc6](https://github.com/pnpm/pnpm/security/advisories/GHSA-vx52-2968-3vc6), environment expansion in proxy settings; patched in 11.11.0.
- [GHSA-c59q-g84q-2gj5](https://github.com/pnpm/pnpm/security/advisories/GHSA-c59q-g84q-2gj5), virtual-store path traversal; patched in 11.11.0.
- [GHSA-vq4v-j7r6-jq4m](https://github.com/pnpm/pnpm/security/advisories/GHSA-vq4v-j7r6-jq4m), dependency manifest name path traversal; patched in 11.11.0.

The requested pnpm/@pnpm/exe 11.13.0 is separately marked broken/deprecated in the
registry; its isolated audit reported zero findings. This is different from the
11.7.0 bootstrap's high finding. The evidence is [investigation 38059297119](https://github.com/seo-rii/svelte-load/actions/runs/38059297119).
The investigation only generated lockfiles with scripts disabled; it did not run
either old pnpm. It demonstrates dependency exposure, not an observed compromise.

11.28.2 is an explicitly reviewed candidate from the latest-11 channel at that
inspection, not a claim that all registry channels point to that newest version.
The exact candidate was not deprecated and its isolated audit was clean.

## Installation and failure behavior

`scripts/setup-pnpm.mjs` checks project/tool pins, the single-package lockfile,
SHA-512 registry integrity and current deprecation metadata. It then runs npm ci
with lifecycle scripts disabled in tools/ci-pnpm, explicitly audits that separate
tree, and only then executes the pinned CLI. It checks the installed version,
actual CLI version from the project directory and the PATH shim's real target.
Only after success does it append that directory to GITHUB_PATH. No old executable,
self-update, @pnpm/exe or floating version is involved.

The incidental install-time audit is replaced by an explicit JSON audit, not
removed. Findings, malformed data, deprecation, registry/network errors, integrity
changes and silently selected CLI versions fail the step. The audit JSON is saved
under RUNNER_TEMP and printed separately from the ORM's own dependency audit.
The normal ORM audit remains enabled. Root/ORM dependency audits do not replace
the package-manager-tree audit, or vice versa.

npm validates downloaded bytes against the committed lock integrity; registry
metadata comparison adds a drift check but is not an independent signature or
provenance verification. Both npm and the registry remain trusted. The bootstrap
script and its lock are reviewable repository code, not protection against an
attacker authorized to rewrite that code. Auditing one bundled CLI package does
not independently audit every embedded source dependency. No total supply-chain
security or exploit mitigation proof is claimed from audit counts alone.

CI sets up Node first and uses the same installer for test, backend and manual
release verification. The existing Node 22 full ORM
CI and backend coverage remain; the separate consumer tests Node 22 and 24.
Publication guards remain. Release dispatch/publication is
not performed by this change. The former pnpm cache setup is removed to avoid
executing a manager before the checked installation; this may make cold jobs
slower. Tool installation uses its own npm lock; the ORM frozen pnpm lock and
approved dependency lifecycle policy stay unchanged.

The helper's unit tests simulate process results to test ordering and failure
paths. Those are not real registry/CLI execution. Real fresh installation, CLI
version, frozen ORM install, full tests, package smoke and backend execution are
recorded by exact commit in the PR. The helper currently targets Linux CI with
Node >=22.13; Windows support is not established by the symlink check.

Tracking: [ORM #2](https://github.com/seo-rii/active-ts/issues/2) and
[svelte-load #16](https://github.com/seo-rii/svelte-load/issues/16). Consumers must
update their pinned ORM commit and call this helper, rather than keep the former
action on their own runner. Historical source revisions remain unchanged.
