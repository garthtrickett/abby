# Clinic-wide first-time intake setting

`SET-005` (`patients.firstTimeIntake.enabled`) defaults to false. `E2E-255` covers its admin, persistence, import and synthetic call behavior. The full local release gate passed for source `3cdf528e9a24fba120daa992936318c3a817b62c` on `codex/abby-first-time-intake-setting`; this document does not authorize live patient creation.

## Authority and scope

The setting belongs to a tenant and clinic and applies across that clinic's locations. It has its own version, independent of both the location policy version and clinic automation version. Reads compose `firstTimeIntakeEnabled` and `firstTimeIntakeVersion` into a call policy. These fields are captured at admission and are never competing authority in location policy JSON. Normal edits affect subsequent calls; the separate emergency write stop still governs active effects.

A raw enabled flag supplies no patient-creation authority. An embedded host must explicitly declare its supported intake mode and independently supply approved draft, consent, duplicate-check, location, call, session, pinned policy and current write authority. Missing evidence cannot create an action. The first caller affirmation is accepted only after the intake confirmation was played. Strict standalone Cliniko always keeps intake unavailable, including when a constructor is given a generous host mode; safe live intake and process-loss reconciliation remain unproven.

## Interfaces and storage

- `settings.patients.firstTimeIntake.enabled.change.v1` takes `expectedVersion` for the **clinic intake version** and boolean `enabled`. The gateway binds scope and actor to the authenticated clinic admin.
- `settings.patients.firstTimeIntake.audit.v1` pages the clinic-wide audit with an optional nonnegative safe-integer `afterVersion`.
- The reference/embedded lit-html dashboard uses `/api/settings/first-time-intake-enabled` and `/api/settings/first-time-intake-audit`. It distinguishes raw state from effective capability. A lost or malformed save reply requires a reread; failed rereads lock editing until reload.
- The global authenticated HTTPS Origin check covers the POST route. The restricted Cliniko availability setup does not expose either route.
- The small `ClinicIntakeSettingStore` seam has memory and PostgreSQL adapters. PostgreSQL migration 037 creates `clinic_intake_settings`; its adapter uses actual Kanel-generated Kysely types. The baseline is version zero, disabled, with no audit metadata. Changes serialize on the clinic baseline row and use compare-and-set. Audit pages contain only version, boolean state, previous boolean state, admin actor reference and time. No patient, appointment or call payload is accepted.
- Rollback refuses to drop recorded intake history. This does not change the explicit rollback targets used by the cancellation and rescheduling proofs.

## Carryover

Archives export one `clinicIntake` history per clinic, regardless of location count. Complete history starts at disabled version zero and has one latest head, contiguous versions and matching previous state. Extra fields, missing or duplicated versions, broken chains and invalid audit metadata are rejected. Legacy archives with no intake history default to disabled version zero.

Reference and durable PostgreSQL imports preserve source audit history. If its head was enabled, the target adds exactly one separate audited disable for that clinic. Repeating a staged import does not add another disable. Intake-only target configuration counts as occupied. The source history retained in the import registry describes the source, while the target audit includes its new disable event. Cutover reconciles the actual intake rows and their metadata, including counts across the entire target tenant; altered audit data or rows under an unlisted clinic prevent route publication.

## Evidence and remaining live gates

Focused checks passed for clinic CAS/isolation, strict standalone capability and location JSON separation, four browser journeys with three workers, reference/PostgreSQL carryover and synthetic voice calls in memory/PostgreSQL. The voice cases cover default off, enabled intake, disable after admission, blocked next call, missing consent, unapproved draft and unsupported host. After a denied request, an unrequested “Yes” must reject with `confirmationMissing` and make no intake read or write. Existing partial-intake/rejected-booking, uncertain-booking and connection-reset cases retain their assertions. No live credentials were loaded; the optional live demo-provider case remains skipped.

The first broad release stopped correctly on an optional live test sharing the synthetic intake file. The live case is now separate and retains its assertions and opt-in gate; no isolation verifier or deadline was relaxed. The corrected source-matched release passed TypeScript, 593 text cases (35 PostgreSQL-only skips), migrations/upgrade/Kanel, 990 PostgreSQL cases (one opt-in live-provider skip), 45 browser cases and their ordering coordinators. The representative sweep passed 18 cases across six files alone and in both four-worker orders. Full mapped isolation passed 234 Node cases across 34 files alone and in both four-worker orders, plus 32 browser cases across six files alone and in both three-worker orders. No mapped case failed or skipped; recorded browser lifecycles prove three overlapping cases. Generated types had no drift and the diff check passed. [Exact release and retained failures](../phase-0/SETTING_E2E_ISOLATION_EVIDENCE.md#clinic-wide-first-time-intake--release-evidence) record source and job provenance. Carrier and live standalone intake evidence remain separate later gates.

## Standalone intake follow-up

The [step-7 standalone proposal](STANDALONE_CLINIKO_FIRST_TIME_INTAKE.md) records memo research E2E-291 and a separate caller-mediated failure contract awaiting explicit product selection. The demo rejected omitted and null patient associations; a memo is not established pre-patient recovery. SET-005 remains unavailable in strict standalone, and neither research nor the proposed contract authorizes caller intake.
