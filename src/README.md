# Text reference runtime

`core/transition.ts` is a pure state transition. `core/ledger.ts` provides an asynchronous, scoped, versioned store interface and an in-memory adapter. `storage/postgres-ledger.ts` implements the same interface with a disposable Kysely/PostgreSQL schema and Kanel-generated row types. `core/runtime.ts` accepts final caller turns, presentation results, and typed effect results. `core/effect-worker.ts` runs host effects only after persisting the possibly-sent state. The worker treats a write transport error as uncertain and creates a reconciliation intent; a task transport error routes its item to operator review. `reference/text-reception.ts` and `reference/command-gateway.ts` exercise the typed host and agent seam through a synthetic reference clinic.

`voice/admission.ts` and `voice/call-liveness-monitor.ts` add replay-safe admission, activation, a session lease, and independent expiry over both ledger adapters. Their [contract and limits](../phase-1/CALL_ADMISSION.md) distinguish this no-number foundation from live transport evidence.

`voice/admission-fallback.ts` adds an [independent synthetic fallback boundary](../phase-1/ADMISSION_FALLBACK.md) for admission failures. Duplicate calls bypass it; provider outcomes and alerts are typed and tested without a live number.

`voice/turn-assembler.ts` and `voice/voice-session.ts` add a [synthetic voice session contract](../phase-1/SYNTHETIC_VOICE_CONTRACT.md): final caller turns and exact playback completion gate the same reference booking path. Both ledger adapters run its journeys. It has no live media or transport evidence.

The [synthetic transfer contract](../phase-1/SYNTHETIC_TRANSFER.md) uses the same durable presentation slot. It distinguishes unsent cancellation, possible provider send, connected, failed, and unproven outcomes, with staff work after failed or unresolved attempts.

Run `npm ci`, `npm test`, and `npm run probe:postgres` (Docker required for the last command). The probe migrates a fresh PostgreSQL database, regenerates Kanel types, and runs the text and storage cases. Test files run in parallel with isolated calls and host fixtures. A new feature, capability, or setting needs a text contract case that checks caller wording, state, effects, and failure behavior. Its real voice path also needs a full-call E2E case when that path exists.

This composition does not call Cliniko or Splose. Its host is synthetic. PostgreSQL persistence is a Phase 0 probe, and a synthetic `played` result is only test evidence for downstream confirmation logic. No production caller, agent, or API can use this harness to assert playback. Production outbox leasing, retention, real host adapters, media, and voice E2E remain open work.
