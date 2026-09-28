# Text-first contract test plan

**Status:** Interim Phase 0 checkpoint. TXT-01 through TXT-09 now run against both in-memory and disposable PostgreSQL ledger adapters through the same text runtime. Four additional PostgreSQL cases check global call-key uniqueness, atomic state/outbox persistence, and host-write and staff-task recovery after a restart. These are not full-call E2E tests. The [Phase 0 exit gate](../PHASE_0_EXECUTION_PLAN.md#phase-0-exit-gate) still requires media and fallback evidence. See the [text storage contract](TEXT_STORAGE_CONTRACT.md).

The [reference host composition](REFERENCE_HOST_CONTRACT.md) adds four journeys that run in both embedded-memory and standalone-PostgreSQL compositions. The `appointments.booking.enabled` toggle is tested for default, enabled, disabled, version conflict, persistence, tenant isolation, and captured next-call behavior. A separate case proves request-only host support does not become executable when that toggle is enabled.

## Test seam and evidence labels

The harness supplies synthetic final caller turns directly to the test composition's call runtime, plus deterministic model proposals, host results, clocks, and staff results. It observes the canonical call/action state, effect intents, caller-facing text intent, and staff read model. It uses the same typed actions and host contracts that the later voice session will call. A synthetic `played` result may test what the runtime does *after* accepted delivery; it is not evidence that a provider played audio. The harness cannot mint caller-confirmation evidence through an agent command or bypass the action digest and later affirmative turn.

Results are labelled **text contract**, **host adapter read**, or **full call E2E**. Only tests entering through the actual voice session may receive the full-call label required by PRD Section 9. A request-only host capability creates staff follow-up; a disabled booking setting is unavailable and makes no booking evidence read. A text fixture cannot promote either state to executable support.

| Case | Synthetic text and injected host state | Expected observable result | Later full-call scenario |
| --- | --- | --- | --- |
| TXT-01 booking | Caller asks for one service/time; host issues one scoped offer; exact details are presented; a synthetic completed-delivery result precedes a later affirmative turn; host returns committed | One keyed write, exact committed receipt, then and only then a confirmation text intent. No write from the first request or before affirmation. | E2E-006 |
| TXT-02 uncertain booking | Same confirmed plan; host result is uncertain after possible send | Pending wording, original action key retained, one reconciliation intent, and visible unresolved work at its deadline; no second write or confirmation. | E2E-065 |
| TXT-03 correction | Caller changes service or appointment type before the old details are confirmed, including A→B→A | Old digest and pending text are superseded. Only the final details can acquire new confirmation; a possibly sent earlier action remains visible for receipt or reconciliation. | E2E-008, E2E-103, E2E-105 |
| TXT-04 ambiguous patient or appointment | Shared phone or multiple matching appointments; caller has not passed approved verification or target selection | No protected appointment detail or mutation; bounded clarification or assigned staff request. | E2E-003; dedicated ambiguous-target ID pending |
| TXT-05 unsupported action | Caller asks for a reschedule or intake that the profile classifies request-only | No PMS mutation; explicit request wording and a staff item with required destination and due time. | E2E-067, E2E-016 |
| TXT-06 partial intake | Approved intake commits a patient reference, but booking is definitively rejected or uncertain | Keep the patient receipt; state that no appointment is confirmed; create and link follow-up without deleting the patient. | E2E-016, E2E-073 |
| TXT-07 failed host read | Patient or offer lookup fails with `unavailable` rather than a definite empty result | No false “patient not found” or “no times” claim; bounded retry or staff path with a typed failure. | E2E-057; dedicated offer-read failure ID pending |
| TXT-08 missing or injected knowledge | An approved answer source is missing, expired, conflicting, or contains tool instructions | No invented answer, no command invocation from source text, and a clarification or staff path. | E2E-058 to E2E-061 |
| TXT-09 staff task failure | A non-voice handoff requires a task, but the host rejects or loses its task response | No claim that staff received it; the canonical item is assigned to operator review or remains visibly unresolved under the original task key. | E2E-038; task-rejection ID pending; voice transfer failure remains deferred |

Each executable case has its own tenant, call, action keys, clock, and host fixture so files run in parallel. The harness asserts caller wording, action state, and effect intents. The PostgreSQL run adds a real transaction boundary and persisted outbox rows, but the disposable adapter is not the production ledger or leased worker.

## Checkpoint result

The text runtime and disposable PostgreSQL proof now cover the current TXT-01–09 baseline. The checkpoint still needs final P0-06/07 contract review, product decisions, and an approved support matrix before it can be called complete. It can guide a text-driven Phase 1 slice. It never replaces playback-completion, interruption, transfer, provider fallback, or end-to-end voice tests.
