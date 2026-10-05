# Cliniko demo lifecycle rehearsal

This owner-run harness tests current Abby session owners against the authorized Cliniko demo API. It does not enable patient workflows in the standalone listener. Mail delivery, independent clinic permissions, inbound admission, caller turns and playback are explicitly synthetic; Cliniko HTTP, patient creation, appointment changes and recovery recalls are real.

## Run

Use an owner-only secret file with `ABBY_CLINIKO_API_KEY` and `ABBY_CLINIKO_CONTACT_EMAIL`. Do not copy it into a worktree, commit it or pass credentials in arguments. The wrapper rejects an unsafe secret file and requires the explicit live flag. The demo must have exactly one active online practitioner and one business, with a related eligible appointment type.

```sh
ABBY_LIVE_CLINIKO_EVAL=1 npm run cliniko:lifecycle-rehearsal -- preflight --secret-file=/home/gust/code/abby/.env --recovery-file=/tmp/abby-cliniko-lifecycle-public.json
ABBY_LIVE_CLINIKO_EVAL=1 npm run cliniko:lifecycle-rehearsal -- status --secret-file=/home/gust/code/abby/.env --recovery-file=/tmp/abby-cliniko-lifecycle-public.json
work run "Abby authorized Cliniko lifecycle" -- systemd-run --user --scope --quiet env ABBY_LIVE_CLINIKO_EVAL=1 node scripts/rehearse-cliniko-lifecycle.ts run --secret-file=/home/gust/code/abby/.env --recovery-file=/tmp/abby-cliniko-lifecycle-public.json
work wait "Abby authorized Cliniko lifecycle" --timeout 45
```

Run from the Abby checkout. If the wait times out, the job is still running: inspect its tracked aggregate log and wait on that job again. Do not start another lifecycle or cleanup concurrently. Shared clinic flags and fixtures make these live flows sequential; independent synthetic checks run with four workers.

## What it checks

1. Confirm eligible public provider selection, refuse existing fixtures, and create an exclusive public business-setting checkpoint before changing the clinic. Temporarily enable the business's online booking flag only when necessary. Create a dedicated synthetic recall type.
2. Admit a volatile call using real clocks and renewed session leases. Read and acknowledge the caller-mediated intake recovery terms. Collect a synthetic adult's private draft and verify an OTP through an in-memory mailbox. Use actual intake policy/session, gateway and SAM confirmation to make exactly one patient creation; inspect the exact provider patient.
3. Under the same intake admission, obtain independently permitted live offers, play the menu and booking details, and affirm separately. Require provider acknowledgment of the Cliniko-owned review record before one appointment POST. Require committed SAM outcome and independent exact appointment/service/practitioner/duration plus conflict readback.
4. Close that owner and allow the provider budget window to settle. A fresh operation-bound verification and admitted owner select the exact appointment and a new live offer. Require played old/new details and separate affirmation before one in-place reschedule. Independently verify the same provider appointment, changed time, duration and clear conflict inspection.
5. After another closed-owner budget window, a fresh verification and admitted owner read the appointment, present the approved cancellation terms and confirm one cancellation. Independently verify the exact canceled provider record and reason.
6. After another budget window, use the returning-patient booking session and a new OTP to book a second appointment. This separately exercises the existing-patient booking composition, rather than treating intake booking as its substitute.
7. Repeat each successful drain and require unchanged send counts. Close every owner before cleanup. Archive only guarded synthetic appointments, recalls, patient and recall type; verify each archive and an empty active fixture read. Restore the original online-booking value through fresh revision checks and an independent provider read.

Successful mutation totals are one intake, two bookings, one move, one cancellation and four recovery recalls. They are attempt counts witnessed at the real fetch boundary; provider outcomes are checked separately. Appointment conflicts are inspections at that instant, not atomic exclusivity. The D-16 best-effort and D-18 caller-mediated loss limitations remain.

Cliniko appointment hosts declare their existing 30-second review/write/readback budget to the effect dispatcher. The worker validates trusted adapter budgets between 1 and 120,000 milliseconds, keeps a 15-second default for undeclared hosts, and honors explicit worker overrides. This does not extend verification, offer or call lifetimes. A timeout after possible dispatch still produces uncertainty, never an automatic repeat or confirmation from a late response. Public practitioner/type and relationship reads overlap; protected patient-authority checks remain sequential because that authority is deliberately non-reentrant.

## Recovery and isolation

Patient references, appointment references, times, private draft, code and notes stay in process memory or Cliniko. The owner-only recovery file contains only public business ID, original online flag, expected business revision and setup state. It also prevents a second run claiming the same checkpoint. It is removed only after verified setting restoration. Public approval files are task-private, contain no patient data, and are deleted when their call closes. Logs expose fixed steps, aggregate counts, booleans and redacted failure codes.

The fixture patient has a fixed synthetic name and reserved `.test` email so a fresh process can discover it without a saved patient reference. Its number is from [ACMA's published fictional mobiles](https://www.acma.gov.au/phone-numbers-use-tv-shows-films-and-creative-works). No real mailbox or mobile subscriber is used. This does not establish that all Cliniko-native communication hooks are suppressed or that any message was delivered.

Unknown sends are never retried automatically. A failed run reports failure even if cleanup succeeds. After confirming its tracked process has ended, inspect `status` and use the guarded cleanup command if necessary:

```sh
ABBY_LIVE_CLINIKO_EVAL=1 npm run cliniko:lifecycle-rehearsal -- cleanup --secret-file=/home/gust/code/abby/.env --recovery-file=/tmp/abby-cliniko-lifecycle-public.json
```

Cleanup refuses ambiguous patients/types, changed private fixture fields or revisions, foreign appointment/review records, and a recall type still referenced by another patient. Patient-specific bookings and staff-review notes are archived in Cliniko; they are not logged locally. Archive is not hard deletion. A pending configuration send or independently edited business blocks automatic restoration and preserves the public checkpoint for inspection. Do not clear that file merely to obtain a passing run. This demo-only cleanup is operator recovery, not a patient-facing rollback promise.

Cliniko can advance the parent patient's revision when an owned appointment changes or is archived. Cleanup checks the original private fields, refreshes the parent after archiving children, and rechecks that fresh revision immediately before archiving it. Any clinical or contact edit still blocks patient cleanup. These read/check/archive steps remain best effort rather than a conditional provider transaction.

Appointment cleanup explicitly includes cancelled records in its read, archive and verification requests. The demo returns 404 for an archive of a cancelled appointment without that scope. Other fixture resources do not accept the appointment-specific cancellation filter. The stateful provider fixture reproduces both rules.

## Evidence and remaining gates

E2E-305 uses a stateful provider double with the actual session owners and SAM. It covers the full lifecycle, duplicate drain, rejected/lost completed booking response, recovery from a fresh fixture owner, foreign-write refusal, preexisting fixture isolation, clinical edit refusal and business edit refusal. A direct provider-shape case accepts an active practitioner without `archived_at`, while rejecting an archived/inactive practitioner or absent appointment-type archive evidence. Live results and exact source/commands are recorded in C-LIVE-59 in [the evidence ledger](../phase-0/CLINIKO_EVIDENCE.md).

This rehearsal supplies no actual email-delivery, carrier, microphone, transcription, human staff-receipt or production clinic-activation evidence. The strict privacy mode and existing speech-admission hold remain in force.
