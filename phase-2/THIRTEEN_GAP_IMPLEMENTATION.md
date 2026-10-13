# Cliniko integration: thirteen-gap implementation order

Activated by the owner: bridge all thirteen gaps in the agreed order, including every part that can be completed without a Twilio number. The October 10 source comparison is an inventory, not a completion claim. Existing no-number contracts and privacy rules still apply.

## Requirements and evidence needed

| Order | Requirement | Current work and completion evidence |
| --- | --- | --- |
| 1 | Wire existing booking, enquiry, cancellation, rescheduling and intake into the running receptionist. | Local engineering proof now covers all five workflows through separately compiled runner subprocesses, signed serving paths, private verification, played confirmation, current-policy denial, independent permission, delivery loss and no replay. CI and real activation remain open under gaps 2–4. |
| 2 | Connect caller verification and clinic-approved permissions. | Separate draft PR 454 adds real TLS SMTP to the actual verifier/protected read with synthetic data; typecheck and 22 checks passed, including failed delivery and independent permission denial. Real sender/mailbox, accepted clinic policy and deploying-host permission source remain open. Channel possession alone cannot grant proxy/minor authority. |
| 3 | Establish message delivery, staff handoff, monitoring and recovery ownership. | Four compiled-runner staff journeys now pass: named saved request, unknown write without replay, permission denial before mail and revocation before send. Existing recall/review/aggregate contracts remain. Deployed monitoring receiver, real sender and human clinic process remain open. |
| 4 | Complete synthetic speech, public transport and eventual carrier qualification. | Prior synthetic runtime evidence exists; noisy/safety and repeated speech gates remain open. Paid probes require restored credits; public tunnel requires a dedicated usable route. Twilio-number carrier evidence is deferred, not substituted with synthetic results. |
| 5 | Expand services, duration choices, locations and initial/follow-up rules. | Current service/intake variants, return rules and independently provisioned multi-location compiled hosts are locally qualified in draft457. Actual clinic configuration/acceptance and authoritative CI remain open. |
| 6 | Extend searches and support online-disabled services where required. | E2E-356 locally qualifies complete approved longer online searches and a compiled two-month late-range booking. E2E-357/358 add independently approved non-recurring native calendars, complete adaptive busy reads, Sunday0/7 and compiled returning/first-time location/member coverage with fresh chosen-day reads. Recurrence and broader real-calendar/serving qualification remain incomplete; preserve incomplete-source denial, date bounds and offer/commit agreement. |
| 7 | Support another approved practitioner during rescheduling. | E2E-359 locally qualifies explicit approved practitioner pairs, independent destination policy, named played confirmation and one inspected in-place move at a changed or retained time. E2E-360 adds the current approved directory, retained original preference, played name/ordinal choice, pagination, fresh-time invalidation and ordinary signed/compiled dialogue. Final type/build and 99 checks passed; current exact-head cloud, real model/acoustic and clinic acceptance remain open. |
| 8 | Add patient detail corrections, required registration fields and resends. | Minimal intake exists; existing-patient correction and delivered resend are incomplete. Require independently authorized updates, contact/index consistency and separate registration/booking outcomes. |
| 9 | Handle multiple patients/actions in one call. | Restricted proxy/identity foundations exist. Require authority for each person, exact appointment selection and independent outcomes; no implicit household disclosure. |
| 10 | Add class attendance booking, cancellation and movement. | Individual endpoints are insufficient. Require existing session/attendee identities, capacity and duplicate checks, compensating move recovery and truthful concurrent-result handling. Membership credits/passes require their own evidence. |
| 11 | Add deposits, paid confirmation, receipts and expiry handling. | Financial boundaries exist, payment lifecycle absent. Require real provider adapter contracts, signed webhook/idempotency, delivered links, separate expiry authority and no refund/coverage/hold invention. |
| 12 | Add outbound follow-up and practitioner sick-day management. | Recalls are not campaigns. Require scoped audience, opt-out, fresh appointment context, scheduler, per-action outcomes and recovery. |
| 13 | Add approved communication/document writeback. | Optional clinical record features need explicit clinic-owned storage and field/content approval. Require no cross-patient/class-shared leakage and concurrency-aware result reporting. |

## Delivery rules

Implement in isolated branches based on current main. Make changes reviewable and verify the affected serving paths before publication. Existing tests/ledgers/negative boundaries are foundations; none establish a missing positive capability. Keep carrier work deferred, preserve the full thirteen-item objective and continue independent implementation when a preceding item's deployment dependency is unavailable.

An actual clinic must select and accept its verification, fees, consent, notification and staff process. Real email and Twilio remain deferred by the owner. These external gates do not prevent building and testing catalogue, routing, provider operations, class, payment and campaign contracts with patient-free fixtures. No patient traffic is admitted merely because a setting, factory or local test exists.

## October 13 progress

Current remote main was inspected at `9a29e51e7f7e0a765db7674c6c75ff2087260473`. No live qualification job was present; historical orphaned jobs were not restarted. The last visible list-only turn supplied no implementation, so it is classified as no progress. This turn changes authoritative source with clinical-host binding, server route wiring and runner composition, and adds an actual standalone signed-call test. Qualification is pending; no gap is yet marked complete.

The first actual standalone-server booking proof passed both tests with zero skips. Typechecking passed after correcting the intake presentation assembly. Initial fixture attempts sent speech before the private-audio drain settled; the fixture now sends paced quiet media, proves silence remains outside transcription and then observes the next voiced request. Other operations, exported-runner subprocess coverage, default-route regressions and publication remain pending; gap 1 is still in progress.

## Initial wiring patch qualification

- `npm run typecheck && npm run build:voice-tests`: passed, tracked job `Abby clinical runner final type and compiled entrypoint gate October 13`, exit 0. Log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791857583921.log`.
- `node --test --test-concurrency=4 test/voice/standalone-clinical-host.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/clinical-model-workflow-call.test.ts test/contract/scenario-manifest.test.ts`: 24 passed, zero failures/skips.
- `bash scripts/with-postgres.sh node --test --test-concurrency=4 test/voice/standalone-voice-service.test.ts test/voice/standalone-voice-profile.test.ts`: 4 passed, zero failures/skips, including the compiled default runner subprocess.
- Both regression stages completed in tracked job `Abby clinical runner regression after compiled stage October 13`, exit 0. Log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791858064489.log`.
- The earlier four-worker run overlapped compilation and failed disposable PostgreSQL startup/cleanup before clinical cases. The successful rerun used the same four-worker commands and caller concurrency after compilation ended. No deadline, gate or assertion was relaxed.
- Manifest 1.147 retains 347 scenarios and planned full-call evidence; E2E-299 adds the standalone clinical-host test file.

This qualifies the initial serving-layer binding change. It does not close the complete first gap: exported clinical-runner subprocess journeys for every operation, real deploying-host permissions/delivery and admission evidence remain open. Remaining gaps 2–13 are unchanged and are not marked complete.

## Compiled runner follow-up

The exported runner now uses the clinical host's current scoped policy for
catalogue validation and the host-selected qualified voice registry for adapter
construction. Nine subprocess journeys passed with zero skips: booking,
cancellation, rescheduling, enquiry, private intake then separate booking,
unknown-write no-replay, independent permission denial, current-policy change
and failed verification transport. Each actual runner remains unready for
ordinary patient routing and denies a non-allowlisted caller.

Command: `bash scripts/with-postgres.sh node --test --test-concurrency=4 test/voice/standalone-clinical-runner.test.ts`.
Tracked result: `Abby complete compiled clinical runner policy and mail failure gate October 13`, exit 0; log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791860537566.log`.

Initial fixture failures were diagnosed: default runner silence is 700 ms (the
new caller initially sent only 100 ms), its IPC listener required explicit
shutdown disconnection, and booking approvals lived outside the caller-policy
folder and needed their own explicit synthetic credential rebinding. These
fixture corrections preserve runtime silence, timeouts, concurrency and
approval checks. Final typecheck, compiled entrypoint build and neighbouring default-route
qualification passed: 14 checks, zero failures or skips. Production admission stays on hold; real permissions, sender,
clinic staff process and speech qualification are not supplied by these tests.

Final command: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh node --test --test-concurrency=4 test/voice/standalone-clinical-runner.test.ts test/voice/standalone-voice-service.test.ts test/voice/standalone-voice-profile.test.ts test/contract/scenario-manifest.test.ts`.
Tracked job `Abby compiled clinical runner final type build and regression October 13` completed exit 0; log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791860823649.log`. This closes the local exported-runner journey evidence listed in the initial qualification. Gaps 2–13 and production activation remain open.

## Verification delivery and compiled staff requests

Draft [PR 454](https://github.com/garthtrickett/abby/pull/454), head
`8a7965a496ce1e0493a345cc1082b56a1cbf2da5`, supplies a fixed verification
email over implicit TLS SMTP. The actual verifier grants a protected read only
after known transport acceptance and independently allowed operation. A lost
DATA acknowledgement cannot grant proof or trigger resend. Typecheck and 22
focused regression checks passed with no skips. Sender provisioning, actual
mailbox receipt and clinic permission approval remain separate gates.

Four additional compiled-runner staff cases passed with zero skips. They cross
the exported runner, signed ingress, private keypad verifier, independent staff
permission and actual Cliniko recall writer. A named request is saved once;
unknown submission remains uncertain and is never replayed; denial before
delivery and revocation after verification stop the send. Status questions do
not promise human receipt or a callback. The compiled provider adapter now
observes staff recall mutations as well as clinical mutations, so the complete
runner regression must be rechecked before publishing this follow-up.

Command: `bash scripts/with-postgres.sh node --test --test-concurrency=4 --test-name-pattern="compiled runner staff request" test/voice/standalone-clinical-runner.test.ts`.
Tracked job `Abby compiled staff runner receipt wording proof October 13`
completed exit 0; log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791863615485.log`.

Initial staff fixture failures were diagnosed: the synthetic intent adapter
discarded a named recipient, and the prohibition assertion matched the negated
phrase “I can't confirm that staff have read it.” The fixture now uses the same
staff-request parser as the real resolver. Named-recipient and explicit
uncertainty assertions remain, including on the subsequent outcome query.
No production gate, worker count, deadline or authority rule was relaxed.

Manifest 1.150 registers these supplementary E2E-311 synthetic journeys and
retains 347 scenarios with planned full-call evidence. Manifest 1.149 belongs to
the independent unmerged SMTP PR and needs reconciliation on rebase. Both
published PRs' GitHub jobs stopped before executing because account billing or
the spending limit blocked Actions; neither is merged or treated as cloud
qualified. The thirteen-gap goal remains active.

The final compiled staff follow-up and neighbouring regression passed 18 checks,
zero failures and skips, including all thirteen compiled clinical/staff journeys.
Command: `npm run build:voice-tests && bash scripts/with-postgres.sh node --test --test-concurrency=4 test/voice/standalone-clinical-runner.test.ts test/voice/standalone-voice-service.test.ts test/voice/standalone-voice-profile.test.ts test/contract/scenario-manifest.test.ts`.
Tracked job `Abby compiled staff runner scoped recall fault and full regression October 13`
completed exit 0; log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791864127994.log`.
The preceding whole-source typecheck passed; its regression stage failed 2 of 18
checks. One failure proved that the new staff fault had incorrectly intercepted
the clinical booking review recall before the intended appointment write. The
adapter now scopes that interception to `staff.request`, retaining the prior
clinical provider path and lost-appointment-write proof. The other failure was
a rescheduling response timeout; the corrected full run passed it with the same
worker counts and deadlines. The timeout's independent cause is not established.
No failing result is presented as a pass, and no real human receipt is inferred.


## Combined clinical runner qualification, 2026-10-13

Dedicated branch `codex/abby-integrated-runner` reconciles the committed heads
of drafts453 (clinical runner),454 (TLS SMTP),455 (aggregate monitoring/operator
responsibility) and456 (current services/history/location/intake). All originated
from main `9a29e51e7f7e0a765db7674c6c75ff2087260473`. Source additions merged;
scenario evidence arrays were united, existing353 scenario meanings retained,
and the new E2E-354 compiled integration was registered at version1.161/354 IDs.
No policy, permission, admission, deadline, privacy or test gate was relaxed.

`ClinikoVoiceClinicalHost` freezes current service mappings and history settings
before constructing calls. The guarded compiled fixture uses the actual initial
service and private-registration components, with real loopback TLS SMTP
certificate/authentication/envelope/message validation. The existing-patient
journey inspects native type34; the first-time journey separately confirms
patient42 and type34/member24. Both scan private fields/codes in PostgreSQL and
runner output. This is synthetic provider/media evidence, not real recipient,
clinic, acoustic or carrier acceptance.

Exact qualification: `npm run typecheck`, `npm run build:voice-tests`,
`npm run build:cliniko-admin`, `npm run build:dashboard`,
`npm run build:sign-in`, isolated PostgreSQL
`node --test --test-concurrency=4` over integrated-clinical-runner,
standalone-clinical-host/runner, smtp-patient-code-delivery, queue-monitor,
operational-alert-inbox/receiver-postgres, operator-alert-workflow/http/process,
cliniko-queue-monitor-systemd and scenario-manifest/no-number-gap-trace files,
then `npx playwright test test/browser/operator-alert-responsibility.spec.ts`
and `git diff --check`. All62 Node checks and the browser journey passed, zero
skips. Work: `Abby combined runner SMTP and monitoring final qualification
October13`. Log:
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791890158011.log`.
The required sign-in asset build was separately tracked and completed before
browser startup in `4590eee3-1791890281469.log`. Earlier merged-source typecheck/
registry and17-check compiled clinical qualification also passed.

At that qualification point the production CLI provisioned one location.
Shared-number discovery was qualified in the transient composition; the
subsequent qualification below connects the actual runner. Real clinic permission/recipient/operating
acceptance, failed acoustic quality, exact-head CI and carrier admission gates
remain separate. The full13 objective is active; gaps6–13 remain incomplete.

## Shared-number clinical runner qualification, 2026-10-13

Gap5 now includes trusted CLI provisioning of named independent location hosts,
current per-location route rechecks and explicit location binding. Public
catalogue questions precede patient lookup, permission, mail, classification and
private intake. Scope-specific policy versions, greetings, FAQs and private input
are retained; no location can supply another location's patient authority.
Credential-wide PostgreSQL budgets remain shared. Clinical counters begin only
after binding and use the chosen location.

Six E2E-355 compiled journeys inspect both exact native businesses/types,
distinct TLS recipients and greetings, route withdrawal before binding and after
verification, independent denial and South's private first-time registration
followed by a separately confirmed type34/member24 booking. Typecheck, compiled
voice build and37 affected checks passed without failures/skips. Exact command:
`npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh node --test --test-concurrency=4 test/voice/compiled-location-runner.test.ts test/voice/integrated-clinical-runner.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/standalone-voice-service.test.ts test/voice/standalone-voice-profile.test.ts test/voice/prelocation-service-discovery.test.ts test/voice/location-service-booking.test.ts test/voice/intake-service-catalogue.test.ts test/cliniko/location-service-directory.test.ts`.
Work `Abby shared-number returning and first-time final clinical gate October13`
completed exit0; log `4590eee3-1791892462458.log` in the shared work log directory.
Manifest1.162 registers355 stable IDs and preserves existing scenario meanings.

The fixture faults and one earlier unreproduced startup exit are recorded in
`phase-1/VOICE_SERVICE_RUNNER.md`; none is hidden as a pass or used to relax a
deadline, worker count or authority check. Real clinic configuration/operating
acceptance, failed acoustic quality, CI execution and carrier gates remain open.
The next implementation is gap6: longer searches and independently approved
availability for services disabled in online booking. Gaps6–13 remain incomplete;
the complete thirteen-gap goal remains active.

## Gap6 longer online search qualification

The first part of gap6 is implemented and locally qualified in
`phase-2/LONGER_CLINIKO_AVAILABILITY.md`: independent scoped search approval,
complete native window reads, preserved date/time constraints, current-host
presentation bounds and fresh proposal/commit evidence. Fifty affected checks,
source typecheck and compiled voice build passed with zero skips. The same
compiled caller request exposed and then verified fixes to both calendar parsing
and the existing menu presentation bound. No test deadline, concurrency,
authority or legacy limit was relaxed.

Next is the offline roster/extra-availability/busy-source calculation. Gap6
remains incomplete, followed by gaps7–13. Production admission, real clinic/mail
acceptance, failed acoustic quality and authoritative CI/carrier gates remain
open; the full13 objective is unchanged.

## Gap6 independently approved offline calendar progress

The current booking source can use an explicit scoped roster plan for services
excluded from online bookings. Native daily/extra openings and all individual,
group and unavailable conflicts are read completely across practitioner
businesses, twice compared and freshly rechecked for the chosen day. DTOs
retain intervals/public labels; private chart fields do not enter offers.
DST and grid rules, full duration across midnight, native pages and approval
withdrawal are covered by E2E-357. Source typecheck, compiled voice build and86
combined checks passed without failures/skips in tracked work
`Abby offline calendar final compiled and source qualification` (log
`4590eee3-1791898132162.log`). Manifest1.164 retains357 stable scenario IDs.

The boundary test exposed filtering next-day openings before merging; this was
fixed and qualified with the original expectation. Fixture counter/default and
command-envelope assertions were corrected without relaxing native write,
authority, privacy, concurrency or deadline requirements. Details and the exact
command are in `phase-2/LONGER_CLINIKO_AVAILABILITY.md`.

Gap6 is still incomplete: non-null/missing recurrence rules deny results, the
weekday mapping needs accepted native evidence, large-source handling and full
service/location serving coverage remain to qualify. Gaps7–13, real clinic/mail
acceptance, acoustic quality, CI execution and carrier evidence remain open.
The full13 objective remains active.


## Gap6 larger calendar and serving qualification

E2E-358 now covers busy ranges over1,000 records through complete smaller reads.
Each child range retains its original page/deadline/credential budget; crossing
native IDs must agree and unique child totals must equal each parent total.
Failed halves, disappearing records, budget exhaustion and dense leaf overflow
cannot publish partial menus. Sunday7 and legacy0 produce the same approved
clinic day, following the inspected Aeva source convention; Abby's own native
provider acceptance remains separate.

Four added compiled journeys qualify North/South45/60-minute offline services,
distinct TLS recipients/scopes, a two-month late booking after a large busy
read, and first-time South registration followed by separate booking with an
approved female member. Typecheck, compiled build, diff check and98 combined
checks passed without failures/skips in work
`Abby adaptive offline parent count corrected full gate`
(log`4590eee3-1791900442880.log`). Manifest1.165 retains358 stable IDs.

The report retains the readonly-budget fixture error, nonexistent private
prompt expectation, a red missing-parent-record witness, and the constructor
syntax restriction. Each correction was verified without weakening runtime
limits or source-completeness checks. Exact commands and source references:
`phase-2/LONGER_CLINIKO_AVAILABILITY.md`.

Gap6 remains open for raw recurrence contract/qualification, large historical
additive sources and real provider/clinic acceptance. Patient-free sandbox
recurrence evidence has been requested asynchronously; independent work can
continue while it is pending. Gaps7–13 and real mail/acoustic/CI/carrier gates
remain open; the full thirteen-gap objective is unchanged.


## Gap7 approved practitioner-change foundation

The concrete rescheduling authority now accepts an explicit approved directional
pair for the exact service/duration and an independent destination booking
policy. Original patient, appointment identity, location, type and duration are
retained. A host-derived change fact distinguishes a same-time practitioner
change from an unchanged request. The menu and confirmation name the new member;
one native PATCH updates the original appointment and exact tuple/conflict
inspection is required for success. The review protocol retains old/new member
context after uncertainty; replay remains denied.

A frozen trusted `reschedulingDestination` is wired through the clinical host,
call flow and session. It is validated before verification and rechecked before
proposal/send. E2E-359 has three compiled signed/TLS caller journeys and protected
source/edge/approval cases. Typecheck, compiled build, diff and101 checks passed
without failures/skips (work`Abby practitioner change final source core compiled
and registry gate`, log`4590eee3-1791902828518.log`). Manifest1.166 retains359
stable IDs. Exact command, API contract and diagnosed failures are recorded in
`phase-2/APPROVED_PRACTITIONER_RESCHEDULING.md`.

Gap7 remains incomplete for caller selection from an approved directory,
retaining the existing practitioner preference and offering an explicit switch
when availability does not suit. Gap6 recurrence/provider/historical additive
work remains open with optional patient-free evidence pending. Gaps8–13, real
clinic/mail, acoustic, cloud CI and carrier acceptance remain open. The full13
objective is active.


## Gap7 caller practitioner choice qualification

Current directory provisioning retains the original member until a played name
or ordinal choice. Independent scoped approvals and native metadata govern up
to 24 members in pages of three. A choice clears the old member's time references,
retains appointment identity/location/type/duration and requires fresh named
confirmation before one PATCH. Empty original searches offer an explicit switch;
uncertain compiled writes retain one attempt.

Typecheck, compiled build, all 99 source/core/model/signed/compiled/registry
checks and diff check passed without failures/skips in tracked work
`Abby caller practitioner choice final source compiled model and registry gate`,
log `4590eee3-1791908652163.log`. Manifest 1.167 registers 360 stable IDs, with
full carrier evidence still planned. Exact commands, earlier failures and
remaining qualification are in
[APPROVED_PRACTITIONER_RESCHEDULING.md](APPROVED_PRACTITIONER_RESCHEDULING.md).

This is local synthetic qualification. Current cloud CI, real clinic/provider/
recipient and actual model/acoustic acceptance remain open. Preserve gap6
recurrence/historical calendar evidence and gaps8–13; the complete objective
remains active.
