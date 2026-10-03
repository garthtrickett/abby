# Magic-link clinic operations: maintainability review

## Direct review — 2026-10-03

Reviewed the changes using the thermo-nuclear code-quality criteria. The existing scope/role-filtered gateway remains authoritative; discovery adds its already implemented read and creates no alternate authorization route. Passing the existing composition clock into its counter store keeps time ownership explicit, with normal default behavior preserved.

The two production edits reuse their canonical layers. No new clinical branch, migration, provider dependency, generic dispatch mechanism or authentication core import is added. The dashboard server remains below 1,000 lines. The browser fixture earns its place by owning a real database, approved account file and application lifecycle, and reuses the established TLS/PostgreSQL helpers. Its clock is fixed, membership replacement is atomic and teardown restores the renamed table before destroying the owned database.

The journeys use actual directory/session resolution and public HTTP/browser paths. They distinguish blocked synthetic speech from release readiness, missing storage from zero counts, current admin membership from a former privilege, and scoped aggregates from patient-linked records. Canary claims name rows/output and defer backup proof to the separate existing storage tests.

No substantive maintainability finding remains in this direct pass. Focused results, the reproduced discovery failure and the missing-bundle command correction are recorded in [the contract](MAGIC_LINK_CLINIC_OPERATIONS.md). Final registered-source and parallel validation remain required before publication.
