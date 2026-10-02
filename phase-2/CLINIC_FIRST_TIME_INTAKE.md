# Clinic-wide first-time intake setting

`SET-005` (`patients.firstTimeIntake.enabled`) defaults to false. `E2E-255` covers its admin, persistence, import and synthetic call behavior. Release validation is still in progress on `codex/abby-first-time-intake-setting`; this document does not authorize live patient creation.

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

## Focused evidence and remaining gate

Focused checks passed for clinic CAS/isolation, strict standalone capability and location JSON separation, four browser journeys with three workers, reference/PostgreSQL carryover and synthetic voice calls in memory/PostgreSQL. The voice cases cover default off, enabled intake, disable after admission, blocked next call, missing consent, unapproved draft and unsupported host. After a denied request, an unrequested “Yes” must reject with `confirmationMissing` and make no intake read or write. Existing partial-intake/rejected-booking, uncertain-booking and connection-reset cases retain their assertions. No live credentials were loaded; the optional live demo-provider case remains skipped.

Full text, PostgreSQL migrations/upgrade probes, browser and manifest-derived parallel isolation release validation remain outstanding. Carrier and live standalone intake evidence are separate later gates.
