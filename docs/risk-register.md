# Risk Register

Generated from [risk-register-data.json](risk-register-data.json). Update that file and run `node scripts/render-risk-register.mjs`.

Audit baseline: [bcabf3c](https://github.com/seo-rii/active-ts/commit/bcabf3ca03312225f8261b96971dbaee4cd737df), reviewed 2026-10-26.

Findings remain active while their PRs await merge. Mark an item resolved after its implementation reaches `main` and the required validation passes.

## Current State

| Metric | Value |
| --- | ---: |
| Active findings | 0 |
| Open | 0 |
| In progress | 0 |
| In review | 0 |
| Accepted | 0 |
| Resolved | 39 |
| Active reproduced bugs | 0 |
| Active improvement proposals | 0 |

## Active Register

| ID | Priority | Finding | Evidence | Status | PR |
| --- | --- | --- | --- | --- | --- |
| — | — | All tracked findings are resolved. | — | — | — |

## Historical Audits

Older audit details are retained in [risk-register-archive.md](risk-register-archive.md). Their historical mitigation status is separate from the commit-specific active register above.

## Maintenance

- Keep stable issue IDs when fixes move between branches or PRs.
- Preserve the audit baseline and evidence level when updating status.
- Use `node scripts/render-risk-register.mjs --check` to verify that this page matches its data.
