# Standalone Cliniko best-effort rescheduling

## Status and contract

D-16 accepts one best-effort in-place move with concurrency limits. `ClinikoReschedulingHost` now composes the existing actual verifier/proof, agent proposal, SAM confirmation, acknowledged Cliniko review and move writer. Tests supply synthetic current target/offer/fee authority, independent permission, email and provider responses. The production runner still declares patient-specific rescheduling unavailable. This is engineering progress; the full nine-step objective remains incomplete.

The same appointment keeps its patient, business, practitioner, type and duration. Confirmation names the exact old and new time in the approved clinic calendar and the approved fee wording. Available time remains provisional; a competing editor or overlapping writer may still win after Abby's final read. D-16 accepts that risk. A clear successful response requires exact new-target read-back, no detected conflict and final current authority before a committed receipt.

## Functions and call map

| Function | Input | Output / work |
| --- | --- | --- |
| `resolveAppointmentChange` | Scoped call/session/policy, actual operation-bound proof, opaque target/offer references and time | Shared guard checks live admitted call, captured/current execution/staff policy, fresh selected target/offer/fee evidence, exact provider binding and initial old-target observation. Returns a portable SAM move or typed failure. Bindings and evidence are cloned before later asynchronous checks. |
| `ClinikoAppointmentChangeGuard.authorize` | Prepared action, actual SAM dispatch, time and signal | Current played confirmation, exact action/effect/digest, call/lease/proof/policy/stop and fresh target/destination/terms/provider checks. Runs before review, after acknowledgment and at the writer's final send point. |
| `ClinikoReviewedSend.run` | Full confirmed old/new provider context and trusted authorization/send ports | Saves one exact pending review in Cliniko, independently checks its acknowledgment and rechecks authority before one possible clinical send. Review success is not staff receipt. |
| `ClinikoRescheduleWriter.rescheduleOnce` | Exact old target and new interval, abort signal, trusted `beforeSend`/`beforeRead` callbacks | Freezes target/scope/destination/callback functions before IO, reads the exact old target, reserves provider budget, rechecks send authority, then issues one possible PATCH. The existing appointment is moved in place. Errors prove pre-send rejection; any possible send with lost/nonexact response stays uncertain. |
| `ClinikoAppointmentChangeGuard.mayInspect` | Prepared original dispatch, time and signal | Fresh call/lease/SAM dispatch/proof/current policy/emergency-stop checks for private read-back and final disclosure. The source need not remain at its old time after the move. |
| `observeReschedule` and private target/conflict reads | Frozen exact source/destination and optional trusted current-read callback | Current state only. Each actual HTTP read runs the callback after its own budget wait. Exact new interval/provider links/active status plus no detected conflict can support the current clear send; later matching state cannot identify the original writer. |
| `write` result and `reconcile` | Original confirmed mutation | A committed receipt only after a clear inspected move and final authority recheck after the last conflict response. Pre-send errors reject; lost, changed, unreadable, revoked or conflicting outcomes stay unresolved. Reconciliation always stays unknown. |
| `dispose`, general staff ports | Trusted call close or unrelated handoff | Close stops retained host/review/proof authority. The owning call also closes its verifier and selection source. General patient handoff remains unavailable pending its own approved Cliniko-owned process. |

Callbacks are private host wiring; they are absent from model/agent schemas and provider payloads. All verification, appointment, recall, mutation and recovery traffic must share the API user's coordinated budget in a standalone deployment.

## Failure, recovery and privacy

A missing or changed review acknowledgment allows no clinical PATCH. An uncertain move stays unresolved even when Cliniko later shows the new time. A detected conflict stays for review even if it later disappears. The pending review survives a killed call owner and a fresh account/type-only owner can discover it. It never grants a new mutation permit or reconstructs lost proof, caller confirmation or an exact original-writer receipt.

The host sends no automatic rollback or replacement booking, repeats no possible PATCH and closes no recall automatically. Review notes carry the full confirmed provider context in Cliniko; Abby retains patient-specific call/proof/target/offer/fee/action state only in memory. The permitted durable patient data remains phone-to-Cliniko-patient-ID index links. Aggregate provider/verification budgets do not restore lost call authority.

E2E-285 covers the actual email verifier, gateway/SAM confirmation, reviewed move, late source/destination/fee/provider or authority changes, lost acknowledgments, conflicts and final-read revocation. Actual isolated PostgreSQL and backup scans check contact/code/proof/call/session/interval canaries and aggregate-only budgets. Real SIGKILL checkpoints occur before review acknowledgment, during PATCH and after an inspected commit. The replacement process receives only public provider configuration, discovers pending full review and performs no new mutation.

E2E-286 covers trusted send/read checks after actual budget waits, false/throw/held/aborted denial, frozen inputs and final inspection authority. Existing embedded change and cancellation proofs still apply to their separately declared contracts. All full carrier-call scenarios remain planned.

## Remaining execution work

1. Implement the concrete current rescheduling fee/notice approval with current scoped administrator and exact public provider/review/calendar bindings. Actual clinic approval remains a separate witness.
2. Connect protected opaque source-appointment selection to concrete operation-bound destination offers. Require the same provider links/duration, current eligibility/relationships/availability, fixed offer expiry and freshly rechecked source/destination/fee policy.
3. Add the trusted admitted rescheduling-session owner and caller-facing played source/destination menu selection, with dedicated email secret entry, one close signal, shared budget, final-composition PostgreSQL/privacy and process-loss evidence.
4. Complete independent patient/action permission, actual clinic policy and human staff-review approval, provider fee/notification behavior, controlled actual provider lifecycle and gated text/voice runner integration.
5. Collect recorded/generated speech evidence and the separately required real carrier/fallback proof before telephone activation.

The owner deferred real email-service setup on 2026-10-04; synthetic delivery tests continue. The pending supervised Cliniko UI witness is not automatically acknowledged or marked recalled. D-06/D-07/D-11/D-16/D-17 remain intact.
