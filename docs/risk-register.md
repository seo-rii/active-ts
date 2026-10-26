# Risk Register

Generated from [risk-register-data.json](risk-register-data.json). Update that file and run `node scripts/render-risk-register.mjs`.

Audit baseline: [bcabf3c](https://github.com/seo-rii/active-ts/commit/bcabf3ca03312225f8261b96971dbaee4cd737df), reviewed 2026-10-26.

Findings remain active while their PRs await merge. Mark an item resolved after its implementation reaches `main` and the required validation passes.

## Current State

| Metric | Value |
| --- | ---: |
| Active findings | 39 |
| Open | 0 |
| In progress | 0 |
| In review | 39 |
| Accepted | 0 |
| Resolved | 0 |
| Active reproduced bugs | 23 |
| Active improvement proposals | 16 |

## Active Register

| ID | Priority | Finding | Evidence | Status | PR |
| --- | --- | --- | --- | --- | --- |
| BUG-159 | P1 | Search revisions reserved after reads can publish stale state last | Reproduced | In review | [#74](https://github.com/seo-rii/active-ts/pull/74) |
| BUG-160 | P1 | Datastore search identities omit complete physical scope | Reproduced | In review | [#94](https://github.com/seo-rii/active-ts/pull/94) |
| BUG-203 | P1 | Read validator input mutation can change record identity | Reproduced | In review | [#50](https://github.com/seo-rii/active-ts/pull/50) |
| BUG-218 | P1 | Malformed Unicode entity IDs can alias Firestore documents | Reproduced | In review | [#62](https://github.com/seo-rii/active-ts/pull/62) |
| BUG-219 | P1 | Datastore automatic cache scope omits the physical endpoint | Reproduced | In review | [#87](https://github.com/seo-rii/active-ts/pull/87) |
| ARCH-010 | P2 | Entity cache ownership maps retain high-cardinality built-in keys | Reproduced | In review | [#89](https://github.com/seo-rii/active-ts/pull/89) |
| ARCH-011 | P2 | SQLite query expressions do not use generated indexes | Reproduced | In review | [#79](https://github.com/seo-rii/active-ts/pull/79) |
| ARCH-012 | P2 | Limited memory queries still use quadratic sorting | Reproduced | In review | [#95](https://github.com/seo-rii/active-ts/pull/95) |
| ARCH-013 | P2 | Search includes refresh owners and relations per hit | Reproduced | In review | [#100](https://github.com/seo-rii/active-ts/pull/100) |
| BUG-204 | P2 | Custom constructors can change a loaded record identity | Reproduced | In review | [#54](https://github.com/seo-rii/active-ts/pull/54) |
| BUG-205 | P2 | Resolved field codec objects remain mutable | Reproduced | In review | [#64](https://github.com/seo-rii/active-ts/pull/64) |
| BUG-207 | P2 | Empty search include disagrees with the full-model return type | Reproduced | In review | [#72](https://github.com/seo-rii/active-ts/pull/72) |
| BUG-208 | P2 | Soft-delete helper lifetime escapes transaction operation tracking | Reproduced | In review | [#80](https://github.com/seo-rii/active-ts/pull/80) |
| BUG-209 | P2 | Function cache keys alias malformed Unicode strings | Reproduced | In review | [#49](https://github.com/seo-rii/active-ts/pull/49) |
| BUG-210 | P2 | Redis cache keys and prefixes alias malformed Unicode strings | Reproduced | In review | [#52](https://github.com/seo-rii/active-ts/pull/52) |
| BUG-211 | P2 | Meilisearch cursors omit query identity and page size | Reproduced | In review | [#55](https://github.com/seo-rii/active-ts/pull/55) |
| BUG-213 | P2 | An empty memory search scope clears every index | Reproduced | In review | [#63](https://github.com/seo-rii/active-ts/pull/63) |
| BUG-214 | P2 | Distributed function caches cannot recover through fresh computation | Reproduced | In review | [#65](https://github.com/seo-rii/active-ts/pull/65) |
| BUG-215 | P2 | SQLite average can overflow for a finite expected result | Reproduced | In review | [#53](https://github.com/seo-rii/active-ts/pull/53) |
| BUG-216 | P2 | SQLite sorting accepts arrays and objects | Reproduced | In review | [#67](https://github.com/seo-rii/active-ts/pull/67) |
| BUG-217 | P2 | SQLite Unicode comparisons diverge from portable ordering | Reproduced | In review | [#71](https://github.com/seo-rii/active-ts/pull/71) |
| BUG-220 | P2 | Integration harnesses swallow falsy rejection values | Reproduced | In review | [#51](https://github.com/seo-rii/active-ts/pull/51) |
| BUG-221 | P2 | Nested test context wrappers restore an outer installation | Reproduced | In review | [#56](https://github.com/seo-rii/active-ts/pull/56) |
| BUG-222 | P2 | Fixture writes leave negative cache entries intact | Reproduced | In review | [#66](https://github.com/seo-rii/active-ts/pull/66) |
| BUG-223 | P2 | Package builds retain outputs from deleted sources | Reproduced | In review | [#69](https://github.com/seo-rii/active-ts/pull/69) |
| DOC-006 | P2 | Published risk metrics do not reflect the current audit | Source review | In review | [#107](https://github.com/seo-rii/active-ts/pull/107) |
| TEST-016 | P2 | Soft-delete unary condition tests exercise string equality instead | Source review | In review | [#106](https://github.com/seo-rii/active-ts/pull/106) |
| TEST-017 | P2 | Adapter parity contracts omit important boundary fixtures | Source review | In review | [#103](https://github.com/seo-rii/active-ts/pull/103) |
| TEST-018 | P2 | Failed test reset settles before other cleanup finishes | Reproduced | In review | [#73](https://github.com/seo-rii/active-ts/pull/73) |
| ARCH-014 | P3 | Context schema and cache coordination need separate responsibilities | Source review | In review | [#101](https://github.com/seo-rii/active-ts/pull/101) |
| ARCH-015 | P3 | Relation loading repeats identity and hook boundary validation | Source review | In review | [#104](https://github.com/seo-rii/active-ts/pull/104) |
| ARCH-016 | P3 | Outbox storage, lease, revision and worker responsibilities are coupled | Source review | In review | [#96](https://github.com/seo-rii/active-ts/pull/96) |
| ARCH-017 | P3 | Search cursor fingerprints need one shared implementation | Source review | In review | [#98](https://github.com/seo-rii/active-ts/pull/98) |
| ARCH-018 | P3 | Cache batch validation and failure recovery diagnostics diverge | Source review | In review | [#108](https://github.com/seo-rii/active-ts/pull/108) |
| ARCH-019 | P3 | Internally created SDK resources need an ownership-aware close API | Source review | In review | [#92](https://github.com/seo-rii/active-ts/pull/92) |
| ARCH-020 | P3 | Testing contexts, contracts and harnesses share one implementation module | Source review | In review | [#102](https://github.com/seo-rii/active-ts/pull/102) |
| ARCH-021 | P3 | Datastore physical identity and runtime responsibilities are coupled | Source review | In review | [#97](https://github.com/seo-rii/active-ts/pull/97) |
| BUG-206 | P3 | Rejected validator configuration leaves partial metadata changes | Reproduced | In review | [#68](https://github.com/seo-rii/active-ts/pull/68) |
| BUG-212 | P3 | Malformed memory cache delete batches partially mutate | Reproduced | In review | [#58](https://github.com/seo-rii/active-ts/pull/58) |

## Historical Audits

Older audit details are retained in [risk-register-archive.md](risk-register-archive.md). Their historical mitigation status is separate from the commit-specific active register above.

## Maintenance

- Keep stable issue IDs when fixes move between branches or PRs.
- Preserve the audit baseline and evidence level when updating status.
- Use `node scripts/render-risk-register.mjs --check` to verify that this page matches its data.
