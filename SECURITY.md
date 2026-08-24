# Security Policy

active-ts is experimental. Please report vulnerabilities through GitHub private
vulnerability reporting for this repository.

Do not open public issues for suspected vulnerabilities until a fix or advisory
is available.

## Supported Versions

No stable release line is supported yet. Security fixes target `main` until a
stable release branch exists.

## Security Boundaries

The shared query DSL is the safe path. Raw `native()` hooks are trusted-only
escape hatches and are not sanitized by active-ts.

See [docs/security.md](docs/security.md) for the current security model.
