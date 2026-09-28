# Text reference runtime

`core/transition.ts` is a pure state transition. `core/ledger.ts` provides an asynchronous, scoped, versioned store interface and an in-memory adapter. `storage/postgres-ledger.ts` implements the same interface with a disposable Kysely/PostgreSQL schema and Kanel-generated row types. `core/runtime.ts` accepts final caller turns, presentation results, and typed effect results. `core/effect-worker.ts` runs host effects only after persisting the possibly-sent state. The worker treats a write transport error as uncertain and creates a reconciliation intent; a task transport error routes its item to operator review. `reference/text-reception.ts` and `reference/command-gateway.ts` exercise the typed host and agent seam through a synthetic reference clinic.

The [scoped staff queue](../phase-2/STAFF_QUEUE.md) exposes redacted, overdue follow-up through the same agent command and standalone dashboard. [Exact-key reconciliation](../phase-2/STAFF_TASK_RECONCILIATION.md) can prove an uncertain task opening in the reference host without repeating the create. The [host-confirmed lifecycle](../phase-2/STAFF_LIFECYCLE.md) adds keyed acknowledgment, reassignment, and resolution to the reference host; Cliniko task support and real operator delivery remain unverified.

[Durable operator alerts](../phase-2/OPERATOR_ALERTS.md) now stage keyed overdue or review-required intents and show delivery, failure, or uncertainty in the staff queue. The reference host provides synthetic keyed delivery; a clinic still needs an approved external destination and independent failure escalation.

The [effect recovery loop](../phase-2/EFFECT_RECOVERY.md) scans pending and aged possibly-sent outbox intents independently of voice sessions. It pages and runs different calls concurrently while preserving per-call order. The local demo starts the loop; a deploying host supplies its own process lifecycle and host lookup.

The [scoped call outcome report](../phase-2/CALL_OUTCOME_REPORT.md) gives agents and the direct dashboard bounded, redacted counts for committed actions, unresolved actions, staff requests, confirmed tasks, and system failures. It does not infer caller abandonment from an ended call.

[Call terminal evidence](../phase-2/CALL_TERMINAL_EVIDENCE.md) records a typed end reason with each new terminal transition. The report distinguishes a transport-verified caller disconnect from expiry, media failure, and transfer completion; older records without a reason remain readable.

`voice/admission.ts` and `voice/call-liveness-monitor.ts` add replay-safe admission, activation, a session lease, and independent expiry over both ledger adapters. Their [contract and limits](../phase-1/CALL_ADMISSION.md) distinguish this no-number foundation from live transport evidence.

`voice/admission-fallback.ts` adds an [independent synthetic fallback boundary](../phase-1/ADMISSION_FALLBACK.md) for admission failures. Duplicate calls bypass it; provider outcomes and alerts are typed and tested without a live number.

The [booking setting audit](../phase-2/SETTING_COMMAND_AUDIT.md) records the host-bound actor and before/after value with each new policy version. Clinic admins can read scoped history through the same command gateway and dashboard; older setting rows remain explicitly unattributed.

The [agent command catalogue](../phase-2/AGENT_COMMAND_CONTRACTS.md) publishes versioned input and result schemas for permitted commands. Proposal commands return redacted turn receipts with trace and action keys; the gateway validates both command and result shapes.

`voice/turn-assembler.ts` and `voice/voice-session.ts` add a [synthetic voice session contract](../phase-1/SYNTHETIC_VOICE_CONTRACT.md): final caller turns and exact playback completion gate the same reference booking path. Both ledger adapters run its journeys. It has no live media or transport evidence.

The [synthetic transfer contract](../phase-1/SYNTHETIC_TRANSFER.md) uses the same durable presentation slot. It distinguishes unsent cancellation, possible provider send, connected, failed, and unproven outcomes, with staff work after failed or unresolved attempts.

The [local media-send lease gate](../phase-1/LOCAL_SEND_LEASE.md) closes output before a conservatively timed session lease expires. Synthetic stall journeys prove that speech and transfer ports are not called after that gate closes.

The [PostgreSQL ledger clock](../phase-1/LEDGER_CLOCK.md) now owns admitted-call deadlines and lease transitions. A real database-clock journey checks that forged process timestamps cannot force or extend lease outcomes.

The [Cliniko availability adapter](../phase-2/CLINIKO_AVAILABILITY.md) reads scoped online-booking eligibility and available times through a bounded, read-only HTTP port. An [opt-in synthetic call journey](../phase-2/CLINIKO_CALL_READ.md) now presents fresh, local-time provisional results through durable voice notices. Returned times are not booking evidence.

The [presentation recovery dispatcher](../phase-1/PRESENTATION_RECOVERY.md) scans durable pending speech or transfer intents after a lost wake-up. It only delivers through the exact attached session and never replays a started intent.

The [in-process voice work loop](../phase-1/VOICE_WORK_LOOP.md) schedules lease expiry before pending-presentation recovery and exposes a commit notification hook. The host still supplies its session registry and commit wiring.

The [per-session lease renewal loop](../phase-1/VOICE_LEASE_LOOP.md) renews an attached call before its local send deadline, retries transient failures, and stops on lease loss. The host starts and stops it with the media session.

The [managed voice-session composition](../phase-1/MANAGED_VOICE_SESSION.md) registers exact attached sessions, starts their renewal loops, and wakes pending delivery after successful call-state commits. It removes sessions when a call ends or a transfer connects.

[Caller notice delivery](../phase-1/CALLER_NOTICE_DELIVERY.md) commits final-turn fallback responses as pending presentations, so the attached session can speak and acknowledge them. A newer turn supersedes an unsent notice.

[Trusted knowledge reads](../phase-1/TRUSTED_KNOWLEDGE_READ.md) let voice intents and agent commands name a source while the host supplies approval, current text, and scope. Accepted answers record source provenance and use the same notice playback path; untrusted or missing evidence produces staff follow-up.

The [standalone lit-html dashboard shell](../phase-1/LIT_HTML_DASHBOARD.md) renders the booking setting and a redacted call summary over the same typed command gateway used by agents. Its local reference server and parallel browser journeys use synthetic clinic data.

Run `npm ci`, `npm test`, and `npm run probe:postgres` (Docker required for the last command). The probe migrates a fresh PostgreSQL database, regenerates Kanel types, and runs the text and storage cases. Test files run in parallel with isolated calls and host fixtures. A new feature, capability, or setting needs a text contract case that checks caller wording, state, effects, and failure behavior. Its real voice path also needs a full-call E2E case when that path exists.

The default demo composition does not call Cliniko or Splose; it uses a synthetic host. A test composition explicitly wires the read-only Cliniko adapter. PostgreSQL persistence is a Phase 0 probe, and a synthetic `played` result is only test evidence for downstream confirmation logic. No production caller, agent, or API can use this harness to assert playback. Production outbox leasing, retention, media, and real voice E2E remain open work.
