# Reference host text composition, version 0.1

**Status:** Executable Phase 0 reference fixture. This proves a small host seam and two text compositions; it is not evidence of Cliniko or Splose mutation support, production staff policy, authenticated voice, or a buyer's actual monolith.

## Host seam

`BookingEvidenceHost.resolveBooking(scope, verificationRef, offerRef, now)` turns opaque host-issued references into a scoped verified patient and bookable offer. The caller or agent cannot supply a patient ref, offer body, or mutation receipt as authority. `HostEffects.write`, `reconcile`, and `openTask` handle the committed effects after the call runtime persists their intent. `PolicyStore.read` and `changeBookingEnabled` capture versioned call policy. The call runtime owns action, presentation, effect, and staff state; the host owns patient and diary facts, booking idempotency, staff delivery, and settings storage.

The reference clinic host accepts only its seeded synthetic proof and offer records. At commit it checks scope, expiry, the exact request digest, and offer occupancy. A repeated action key with the same payload returns the same booking reference; a changed payload or scope is rejected. Reconciliation looks up the original action key. Staff-task opens use the original task key and reject changed payload or scope. No real PMS SDK or patient record is used.

## Two compositions, one call core

| Composition | Call and policy storage | Host methods and effect worker |
| --- | --- | --- |
| Standalone reference | PostgreSQL `PostgresLedger` and versioned `PostgresPolicyStore` via Kysely/Kanel | `ReferenceClinicHost` and the shared `EffectWorker` |
| Embedded reference | Host-supplied `LedgerStore`, versioned `EffectCallLeaseStore`, and `PolicyStore`; the fixture supplies in-memory adapters | The same `ReferenceClinicHost`, `TextReception`, and `EffectWorker` |
| Embedded reference voice | The same host-supplied ledger and policy, with host-owned number routing and media ports | The shared `ConnectedVoiceCall` and `VoiceSession` with a reference host; E2E-144 proves greeting playback and staff work, while E2E-145 proves a keyed booking after exact playback and affirmation without standalone storage |
| Cliniko-only standalone text | Strict PostgreSQL call ledger and minimal settings; optional scoped Cliniko availability reader | An internal disabled host rejects patient mutations and staff tasks; no reference host is required |

The availability text runner accepts the shared `TextReception` seam. The standalone wrapper supplies strict PostgreSQL storage and a scoped Cliniko reader; an embedded buyer can supply native call and policy storage with the same reader and ingress. E2E-125 covers provisional, empty, and failed reads in both compositions. On a failed read, the embedded reference host can own its configured staff work, while the Cliniko-only standalone composition still disables patient-specific handoff under D-07. This text evidence does not prove a live call or buyer integration.

After the text transport accepts the response, one atomic `textPresentationWritten` transition records the presentation as played and closes its synthetic text call with a `textCompleted` terminal reason. A repeated acknowledgment for the same presentation returns the committed result without a second event. The strict standalone ledger retains random call, turn, and presentation IDs plus operational statuses, including the terminal marker; it retains no caller words or offered times. An embedded host may continue processing its own pending staff work after the text call ends.

The embedded composition imports no standalone storage or generated database type. The proposed default for `appointments.booking.enabled` is `false`, which makes booking unavailable without a patient or offer read. When enabled, the effective mode is the host declaration: executable for the safe reference host or request-only for a restricted reference profile. A later change affects new calls while existing calls keep their captured policy. This text fixture assumes the separate clinic-wide `automation.enabled` gate is already on. SET-001 has an admin command, audit, and fail-closed readiness port; its reference host has no live readiness proof. The reference owner and operator destinations are synthetic, not clinic-approved defaults.

## Agent-native text ingress

`CommandGateway` is constructed with a host-supplied actor and bound location scope. It returns versioned, role-filtered capability descriptors and typed results for `settings.read.v1`, `settings.appointments.booking.enabled.change.v1`, and `booking.propose.v2`. An agent can propose a booking using opaque proof and offer refs, but cannot change the setting or submit caller affirmation through the gateway. A proposal creates no host write. A trusted text-presentation acknowledgement and a later clear caller affirmation of the exact digest are required before the shared worker can write. An ambiguous proof creates a staff task without an appointment disclosure or mutation.

The gateway currently trusts the embedding host to authenticate the actor before construction. It has no durable actor-command audit or staff approval workflow yet; those remain required for a production agent surface. `TextReception.acknowledgeTextPresentation` is a synthetic text-delivery seam for this reference composition. It does not prove audio playback and must not be exposed as an agent command.

## Verification and open work

The same four composition journeys run against embedded memory and standalone PostgreSQL: exact booking, default/enable/disable and next-call setting behavior, enabled booking with request-only host support, and ambiguous evidence with staff fallback. They assert caller wording, action and staff state, actual reference-host records, tenant isolation, permissions, and no pre-confirmation write. E2E-178 adds a shared Cliniko read-only text corpus across strict standalone and embedded compositions for shown, empty, and rate-limited availability. E2E-179 runs those same cases through signed synthetic Twilio voice in both compositions. Each fixture owns a disposable database; embedded host work does not enter Abby's standalone call tables. The import-boundary contract walks the portable call graph to reject dependencies on Cliniko and standalone storage modules. Existing TXT-01–09 and storage cases remain separate. Run `npm test` and `npm run probe:postgres`.

Product approval of the setting, verification method, staff destinations, and caller language is still open. Later slices added a browser UI and a [durable booking-setting command audit](../phase-2/SETTING_COMMAND_AUDIT.md) in the PostgreSQL composition. Other administrative audit, host-authenticated agent sessions, real Cliniko/Splose mutation adapters, patient discovery, and live voice delivery remain open. The [Phase 0 exit gate](../PHASE_0_EXECUTION_PLAN.md#phase-0-exit-gate) stays open.
