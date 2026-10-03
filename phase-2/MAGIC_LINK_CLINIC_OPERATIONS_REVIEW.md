# Magic-link clinic operations: maintainability review

## Direct review — 2026-10-03

Reviewed the changes using the thermo-nuclear code-quality criteria. The existing scope/role-filtered gateway remains authoritative; discovery adds its already implemented read and creates no alternate authorization route. Passing the existing composition clock into its counter store keeps time ownership explicit, with normal default behavior preserved.

The production edits reuse their canonical layers. No new clinical branch, migration, provider dependency, generic dispatch mechanism or authentication core import is added. The dashboard server remains below 1,000 lines. The browser fixture earns its place by owning a real database, approved account file and application lifecycle, and reuses the established TLS/PostgreSQL helpers. Its clock is fixed, membership replacement is atomic and teardown restores the renamed table before destroying the owned database.

The observed broad browser failure is resolved with the panel's existing busy state rather than a new startup cache, shared-request mechanism or wider deadline. It renders authorized loading before reads finish and keeps unknown approval separate from absent approval. A held actual catalogue request verifies disabled actions and subsequent real data. Existing completed-failure wording is preserved.

The journeys use actual directory/session resolution and public HTTP/browser paths. They distinguish blocked synthetic speech from release readiness, missing storage from zero counts, current admin membership from a former privilege, and scoped aggregates from patient-linked records. Canary claims name rows/output and defer backup proof to the separate existing storage tests.

No substantive maintainability finding remains in this direct pass. Focused results, the reproduced discovery failure and the missing-bundle command correction are recorded in [the contract](MAGIC_LINK_CLINIC_OPERATIONS.md). Final local validation passed on `67ea968`: typecheck, 19 Node/PostgreSQL checks and 75 browser journeys, plus all 62 mapped journeys across 13 files alone and in both three-worker orders. Every final selected case has zero failures/skips. The earlier broad failure remains explicit. After rebasing onto merged proposal PR #358, publication registration/trace validation passed two checks without skips, and runtime/dependency/registry inputs compare identical to the frozen passing source. Only documentation and the inherited overview contract assertions changed after the full release.
