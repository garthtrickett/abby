# Text call storage contract, version 0.1

**Status:** Executable Phase 0 probe. This freezes the text-side `LedgerStore` interface for the current synthetic reference composition. It is not the full voice, retention, or production outbox contract in [the technical design](../TECHNICAL_DESIGN.md).

## Interface and ownership

`LedgerStore` has three operations: `start(callId, policy)`, `read(callId, scope)`, and `apply(callId, scope, expectedVersion, action)`. `CallRuntime` binds one location scope; every read and transition uses it. A missing or foreign-scope call returns `callUnknown` so cross-tenant existence is not disclosed. `apply` compares the expected version and returns `versionConflict` without accepting an action when stale. A duplicate accepted turn ID with the same payload digest returns the stored state without a new event; changed content under that ID returns `keyMismatch`. Storage faults return `storageFailure`; malformed stored state returns `storageCorrupt`.

The core owns decisions through the pure `transition`. The ledger adapter owns atomic persistence and cannot add a new action decision. The in-memory and PostgreSQL adapters run the same TXT-01–09 cases. Kanel-generated row types are imported only under `src/storage/`; core types and the host worker do not depend on PostgreSQL, generated rows, or Kysely.

## Text transaction decisions

| Transaction | Accepted input and atomic result | Crash or replay meaning |
| --- | --- | --- |
| T1 subset: start | Insert one globally unique call ID with captured scope, policy version, and initial state at version 0. | A duplicate call ID is rejected, including from another tenant. Admission routing and voice-start deadlines are deferred. |
| T2 subset: turn, presentation, dispatch mark | Under the scoped call row lock, check version, run the pure transition, then advance state and version, append a minimal audit event, and update changed outbox and staff rows in one transaction. | A stale writer has no partial effect. A pending write is canceled by a correction that wins before the possible-send mark. If the mark wins, the old action remains visible. |
| T3 subset: effect result or recovery | The transition checks the stored effect kind, action/task key, and valid status. State, audit event, outbox status, and staff projection commit together. | An uncertain write creates one reconciliation intent under the original action key. No second host mutation is dispatched. A late or duplicate result cannot create another effect. |
| T4 subset: presentation result | A synthetic result may change a `started` presentation to `played`, `interrupted`, or `failed` in the same versioned transition. Only exact `played` evidence permits a later affirmative turn. | This proves text confirmation ordering only. There is no media dispatcher, delivery lease, or real playback proof. |

The probe schema has `calls`, `call_events`, `effect_outbox`, `staff_items`, and `clinic_settings`. `calls.call_id` is globally unique, while reads and updates require tenant, clinic, and location. `call_events` stores only IDs and interpretation/effect kinds, not raw caller text. The current call snapshot and staff projection hold synthetic test details; retention and encryption policy are future work. `clinic_settings` establishes a versioned schema shape but is not yet consumed by the runtime.

## Possible-send recovery

The worker commits `possiblySent` before calling a host. A transport failure turns the write into `uncertain` with a reconciliation intent. If a process disappears after that mark, a restarted runtime can accept `recoverHostPossiblySent` after a bounded delay and create the same uncertain path. The original mutation is never sent again by that recovery action. A lost staff-task response moves the existing task key to operator review; `recoverStaffPossiblySent` does the same after a process loss. These probe actions use an injected clock so tests are deterministic. Production recovery requires ledger-owned time, effect leases, independent scanning, and host-specific exact lookup before any automated retry.

## Verification and remaining gates

`npm test` runs typechecking and the 16 memory text cases. `npm run probe:postgres` creates a disposable local PostgreSQL container, migrates up/down/up, regenerates Kanel types, then runs those 16 cases and four storage cases. Test files run in parallel and use distinct tenant/call keys. CI runs typecheck, memory cases, and the PostgreSQL proof as separate jobs; the PostgreSQL job also rejects generated-type drift.

This probe does not implement the production ledger, leased outbox worker, settings behavior, retention, an embedded-host storage adapter, provider writes, or a full-call voice path. The [Phase 0 exit gate](../PHASE_0_EXECUTION_PLAN.md#phase-0-exit-gate) remains open. The disposable schema is a proposal for those later contracts, not evidence that Cliniko or Splose can safely execute a mutation.
