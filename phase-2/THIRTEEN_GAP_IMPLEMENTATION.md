# Cliniko integration: thirteen-gap implementation order

Activated by the owner: bridge all thirteen gaps in the agreed order, including every part that can be completed without a Twilio number. The October 10 source comparison is an inventory, not a completion claim. Existing no-number contracts and privacy rules still apply.

## Requirements and evidence needed

| Order | Requirement | Current work and completion evidence |
| --- | --- | --- |
| 1 | Wire existing booking, enquiry, cancellation, rescheduling and intake into the running receptionist. | Local engineering proof now covers all five workflows through separately compiled runner subprocesses, signed serving paths, private verification, played confirmation, current-policy denial, independent permission, delivery loss and no replay. CI and real activation remain open under gaps 2–4. |
| 2 | Connect caller verification and clinic-approved permissions. | Separate draft PR 454 adds real TLS SMTP to the actual verifier/protected read with synthetic data; typecheck and 22 checks passed, including failed delivery and independent permission denial. Real sender/mailbox, accepted clinic policy and deploying-host permission source remain open. Channel possession alone cannot grant proxy/minor authority. |
| 3 | Establish message delivery, staff handoff, monitoring and recovery ownership. | Four compiled-runner staff journeys now pass: named saved request, unknown write without replay, permission denial before mail and revocation before send. Existing recall/review/aggregate contracts remain. Deployed monitoring receiver, real sender and human clinic process remain open. |
| 4 | Complete synthetic speech, public transport and eventual carrier qualification. | Prior synthetic runtime evidence exists; noisy/safety and repeated speech gates remain open. Speech-provider credits were restored in the earlier investigation; public tunnel still requires a dedicated usable route. Twilio-number carrier evidence is deferred, not substituted with synthetic results. |
| 5 | Expand services, duration choices, locations and initial/follow-up rules. | Current service/intake variants, return rules and independently provisioned multi-location compiled hosts are locally qualified in draft457. Actual clinic configuration/acceptance and authoritative CI remain open. |
| 6 | Extend searches and support online-disabled services where required. | E2E-356 locally qualifies complete approved longer online searches and a compiled two-month late-range booking. E2E-357/358 add independently approved non-recurring native calendars, complete adaptive busy reads, Sunday0/7 and compiled returning/first-time location/member coverage with fresh chosen-day reads. Recurrence and broader real-calendar/serving qualification remain incomplete; preserve incomplete-source denial, date bounds and offer/commit agreement. |
| 7 | Support another approved practitioner during rescheduling. | E2E-359 locally qualifies explicit approved practitioner pairs, independent destination policy, named played confirmation and one inspected in-place move at a changed or retained time. E2E-360 adds the current approved directory, retained original preference, played name/ordinal choice, pagination, fresh-time invalidation and ordinary signed/compiled dialogue. Final type/build and 99 checks passed; current exact-head cloud, real model/acoustic and clinic acceptance remain open. |
| 8 | Add patient detail corrections, required registration fields and resends. | E2E-361–368 locally qualify patient corrections, account revisions, linked recovery, private edit/reset and guarded setting-history portability. E2E-369 adds independently approved required address fields, complete private collection/readback, field-bound host authority, native response/inspection and separate registration/booking confirmation; final typecheck/build and80 checks passed without skips. E2E-370–379 qualify resend SMTP, native evidence, SAM consent, signed private selection/paging, interruption recovery and mapped staff receipt inspection. E2E-380 now locally qualifies explicit versioned in-person/telehealth/cancelled formats through116 final checks. Unsupported clinic-specific field adapters and production recovery-host/operator integration/acceptance remain open; current-head cloud and actual clinic/mail/model/acoustic acceptance are absent. |
| 9 | Handle multiple patients/actions in one call. | E2E-381 locally qualifies independently verified same-caller tasks and preserved native/signed outcomes. E2E-382 adds exact private related-person selection, independent adult/guardian authority and selected-channel protected reads. Published E2E-383 adds native adult/guardian booking and related-person cancellation/move under the unchanged shared API budget; final type/build and102 checks passed without skips. E2E-384's trusted private CallFlow/keypad booking route, constructor/task-process denial and existing serving regression passed final type/build and106 checks without skips. Ordinary private identity speech and root lifetime composition, multiple-person task journeys, unrelated representatives without a native self record, alternative guardian channels, other representative CallFlow operations, cross-operation/catalogue sequences and staff outcomes remain unfinished. |
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


## Gap8 patient-correction provider foundation

Follow-up qualification reproduced a mutable contact callback changing the
returned patient ID from the actual native target 42 to 43. The provider now
passes independent copies of both the request and inspected snapshot to that
callback. The red witness failed its single assertion before the fix (log
`4590eee3-1791913476263.log`). The corrected focused gate passed typecheck,
56 tests with zero failures/skips and diff check in tracked work
`Abby patient correction callback isolation final focused gate`, log
`4590eee3-1791913499875.log`. Command: `npm run typecheck && node --test
--test-concurrency=4 test/cliniko/patient-update.test.ts
test/cliniko/patient-intake.test.ts test/cliniko/patient-intake-lifecycle.test.ts
test/cliniko/transient-intake-authority.test.ts
test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts
&& git diff --check`. Caller policy/flow and contact synchronization remain open.

[Cliniko's patient update operation](https://docs.api.cliniko.com/openapi/patient/updatepatient-patch) supports a PATCH to the existing patient. Its fields were checked against the current official API and downloaded OpenAPI request body. The patient record is shared across the Cliniko account; the authority contract names that scope explicitly. This source does not create a new patient or touch appointment endpoints.

`patient-details.ts` projects transient identity/contact snapshots, excluding chart, billing and marketing fields. Native identity/self-link, unarchived/unmerged status, complete contact fields and a valid updated timestamp are required. Before-state and correction digests bind the private payload. Field limits, Gregorian dates, canonical email, phone types, address fields and syntactic country codes are checked; future self birth dates and newly introduced noncanonical phone numbers cannot send. Missing fields are never invented.

`ClinikoPatientUpdateEdge` requires a separate current patient-update attestation, independent permission, self authority, allowed fields and privately played complete correction. An email change also requires a prospective address-proof reference and exact email digest. Current source state is inspected before a narrowly serialized PATCH. All unchanged protected fields and the requested changes must match both the known response and a fresh native readback. These checks declare a best-effort write; they do not provide backend conditional-update protection against competing actors.

One possible send consumes the patient/call/session attempt. Lost, malformed, failed or aborted results remain uncertain without retry. Concurrent duplicates cannot release another request's live lock. A no-op returns `unchanged` without mutation. After known readback, an explicit owner callback must revoke stale contact grants and synchronize affected lookup state before returning `updated`; callback rejection or exception returns `needsContactReview`. That callback contract is implemented at the edge; a real proof/index adapter is still required. A failed or missing sender/proof/lookup cannot be replaced by a checkbox or a success claim.

The first authority/field run passed typecheck and 29 checks in `4590eee3-1791911527558.log`. An extended cancellation test then had a TypeScript result-union error; no runtime assertion executed in that failed gate (`4590eee3-1791912164810.log`). Narrowing the successful result before comparing its payload fixed the test. The corrected lifecycle run passed 45 checks (`4590eee3-1791912348791.log`). Final exact-source qualification passed typecheck, compiled build, all 55 source/lifecycle/registry checks and diff check without failures/skips, tracked work `Abby patient correction provider final registry and existing workflow regression`, log `4590eee3-1791912988660.log`, exit 0.

```sh
npm run typecheck && npm run build:voice-tests && node --test --test-concurrency=4 test/cliniko/patient-update.test.ts test/cliniko/patient-intake.test.ts test/cliniko/patient-intake-lifecycle.test.ts test/cliniko/transient-intake-authority.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check
```

Manifest 1.168 registers 361 stable IDs. E2E-361 has provider-edge text evidence only; signed/compiled caller and full carrier evidence remain planned. No patient-facing update workflow, clinic permission/settings, actual old/new contact proof, private collection or complete contact/index synchronization is supplied by this provider-layer patch. Required registration fields and confirmation resend transport also remain gap8 work. The full thirteen-gap objective is active, including pending recurrence/historical availability and real speech/model/clinic acceptance. Exact-head cloud qualification is required after publication; preceding workflows stopped at GitHub billing before any test step.


## Gap8 independent correction policy and verification

`OwnerFilePatientUpdatePolicy` captures a separate owner file and current clinic administrator membership. It pins policy/correction versions, native business, credential fingerprint, location and clinic time zone. The exact approval names account-wide patient-record scope, allowed identity/contact fields, adult self eligibility, independently supplied patient permission, registered-address verification, prospective-address verification, private readback and contact synchronization. Approval or membership changes revoke the captured policy. Booking and registration approvals cannot be used here.

Private corrections require current privacy/account-wide terms, trusted native existing birth date and clinic-local adult eligibility for both existing and corrected birth dates. Unsupported fields, proxy/minor requests, removing the birth date or email, stale terms and clock expiry deny the request. This policy publishes no patient proof or correction values. It snapshots asynchronous input and uses the existing bounded owner-file approval source.

The shared patient-operation vocabulary now includes `patients.update`; the existing owner-file verification policy, email authority and transient proof host accept that distinct operation. The actual call verifier qualifies independently permitted update proof, denies using it for booking or appointment reads, and invalidates it after registered contact changes. It does not implicitly grant new fields, prospective email proof or an update send. The ordinary clinical runner does not yet offer this workflow.

Qualification: typecheck, compiled voice build, diff check and65 checks passed with zero failures/skips in tracked work `Abby patient correction policy final type build registry and verifier gate`, log `4590eee3-1791914176027.log`. The preceding runtime gate passed62 checks (`4590eee3-1791914113708.log`). The first typecheck stopped on a test's nonexistent fixture `now` property (`4590eee3-1791914032716.log`); it now calls the fixture's existing clock. No runtime gate or assertion was relaxed.

```sh
npm run typecheck && npm run build:voice-tests && node --test --test-concurrency=4 test/cliniko/patient-update-policy.test.ts test/cliniko/patient-update.test.ts test/cliniko/owner-file-caller-policy.test.ts test/cliniko/email-patient-authority.test.ts test/cliniko/transient-patient-proof.test.ts test/cliniko/intake-clinic-policy.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check
```

Manifest1.169 retains361 IDs and adds policy/verifier text evidence to E2E-361. Signed/compiled update caller and carrier evidence remain planned. Host settings, private correction collection/readback, prospective email verification, a write-owned post-send inspection authority, concrete account-wide proof/index synchronization and owned review remain required. A normal old-address proof must not simply be reused after the native email changes; post-send inspection needs transaction-specific ownership and current independent permission. Required intake fields and confirmation resends also remain gap8 work. Gaps6 recurrence/historical sources,9–13 and real clinic/mail/model/acoustic/cloud gates remain open.

Callback fix head `0d876595ce32535649214099c4948c49237f274f`: PR38441813382 and push38441804341 completed failure with zero steps in all four jobs. Fresh annotations confirm GitHub account payments/spending limits prevented startup. Those terminal failures do not qualify the new policy source. The PR remains draft and the full thirteen-gap objective stays active.


## Gap8 private correction owner and separate SAM action

The new `patientUpdate` action retains only opaque private correction/consent references, correction version and verified-subject metadata. Neither changed values nor value digests enter SAM, model progress or ordinary confirmation speech. Legacy host capabilities omit this action and deny it; standalone safe storage rejects enabling it. The new host-only `patients.correction.propose.v1` accepts a correction reference, resolves fresh private evidence and leaves confirmation/dispatch to SAM. Ordinary clinical runner routing still declines this workflow until its private voice owner and configuration are wired.

`ClinikoPatientCorrectionSession` binds an admitted active call, current lease/write-stop/policy, separate clinic correction approval, exact native credential, registered-email verifier and independent patient permission. It privately plays terms, takes a separate acknowledgment, captures a fresh native before-snapshot, validates requested fields against native adult eligibility, plays the complete private readback and verifies a prospective email code when needed. Recollection clears old draft/action/code references. Mailbox possession never supplies action permission.

A played SAM confirmation and exact dispatched effect are required before the native review writer records the correction operation. The review contains subject/context and the opaque correction reference, with no raw correction values. Only after review acknowledgment and a fresh authority check can the patient edge claim one attempt. The claim consumes the old registered-channel grant before PATCH. Post-send inspection requires the same claimed transaction, original expiry, live call, current policy and independent permission; it never reuses the now-stale old email proof. The concrete account-wide synchronizer remains a required owner port and is not supplied by this patch. Failed synchronization, lost review/write and revoked permission remain uncertain and cannot replay.

Concrete failures were diagnosed without changing limits or assertions:

- Initial action typecheck found a widened workflow union and old fixture operation assumptions (`4590eee3-1791914625845.log`). Ordinary Cliniko routing now explicitly excludes corrections until integrated; legacy review fixtures retain their exact native operation types.
- Initial private fixture omitted `observe429` from its shared budget (`4590eee3-1791915250128.log`), then assumed a fixed code instead of the actual synthetic delivered code (`4590eee3-1791915300938.log`). Both fixture contracts are corrected.
- A later private collection failure exposed a real verification-reference mismatch (`4590eee3-1791915342532.log`). The verifier issues base64url references, which may begin with `_` or `-`; native and SAM correction validation incorrectly required a leading alphanumeric character. A single-case red witness reproduced denial (`4590eee3-1791915438914.log`); corrected validation retains the full issued alphabet and all authority checks.
- Contact synchronization could revoke permission after inspection but still return updated success. A red witness reproduced that false success (`4590eee3-1791915714355.log`); the provider now reattests after successful synchronization before issuing success.
- Type qualification found incomplete typed budget responses and broad legacy review fixtures (`4590eee3-1791915552596.log`). The budget returns the required rate-limit observation; the synthetic discovery worker counts new correction reviews without changing its legacy output.
- The first broad gate passed type/build and116 checks but omitted the required PostgreSQL environment (`4590eee3-1791915812390.log`). Its corrected wrapper run passed126 checks but lacked migrations for two storage tests (`4590eee3-1791916039793.log`). The final command explicitly migrates its disposable database before the same four-worker suite. No failure is counted as qualification.

The final source typecheck, migrated database gate, all128 checks and diff check passed with zero failures/skips in tracked work `Abby correction final migrated database source and runtime qualification`, log `4590eee3-1791916243741.log`. This includes real host capability/SAM/provider flows, account-credential mismatch denial, safe PostgreSQL storage, fresh-process appointment review recovery and existing signed structured-model workflows.

```sh
npm run typecheck && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/patient-correction-session.test.ts test/text/patient-correction.test.ts test/cliniko/patient-update.test.ts test/cliniko/patient-update-policy.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/review-discovery.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/email-patient-authority.test.ts test/cliniko/transient-patient-proof.test.ts test/cliniko/owner-file-caller-policy.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/text/partial-intake.test.ts test/text/effect-recovery.test.ts test/text/agent-appointment-proposals.test.ts test/storage/standalone-call-state.test.ts test/voice/clinical-model-workflow-call.test.ts test/cliniko/review-discovery-process.test.ts test/cliniko/reviewed-send-process.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check
```

Manifest1.170 retains362 stable IDs. E2E-362 records text/private-owner evidence; signed/compiled correction caller and carrier evidence remain planned. Gap8 still needs ordinary runner/private voice integration, settings, concrete account-wide contact/lookup invalidation, correction review process-loss qualification, required intake fields and resends. Gap6 recurrence/historical sources, gaps9–13 and real clinic/mail/model/acoustic/cloud gates remain open. The full thirteen-gap objective remains active.


Final current-source compiled follow-up passed `npm run build:voice-tests && node --test --test-concurrency=4 test/voice/clinical-model-workflow-call.test.ts && git diff --check`:7 checks, zero failures/skips, tracked work `Abby correction current compiled build and existing signed model workflows`, log `4590eee3-1791916445831.log`. This rebuild includes the final native-account binding; it qualifies existing signed model workflows and does not claim signed correction routing.


## Gap8 independent correction setting and admin controls

Patient corrections now have a clinic-wide, default-off preference with an independent version and audit history. It is separate from booking, registration, location-policy versions and host/patient permission. Memory and PostgreSQL policy composition require explicit host support; a saved enable cannot activate an unsupported or minimal-storage host. Default and decoded location policies cannot supply their own correction preference/version. The correction owner compares both captured and current setting version with the exact clinic approval, so disable/re-enable does not revive old consent or a ready write.

Migration043 adds `clinic_patient_correction_settings`: public tenant/clinic/version, enabled state, actor, previous state and timestamp only. The version-zero row locks concurrent clinic edits across locations; stale edits lose CAS. Audit pagination and immutable memory returns retain actor attribution. Rollback refuses to erase setting history. Kanel types were regenerated against a migrated disposable PostgreSQL database; only the new table and PublicSchema mapping changed.

Authenticated clinic admins can edit/audit through `settings.patients.corrections.*` and the dashboard. Bodies contain expected version and enabled flag only; actor/scope are server-derived. Staff/agent edits, injected fields and stale versions are denied. The dashboard displays shared clinic state and audit history, re-reads after unknown edits and explains that disabling also stops active correction calls. The existing synthetic correction fixture now enables the real setting through the policy store rather than inventing an execute capability.

Qualification:

- `npm run typecheck && npm run build:voice-tests && npm run build:dashboard && node --test --test-concurrency=4 test/text/patient-correction-setting.test.ts test/storage/postgres-patient-correction-setting.test.ts test/cliniko/patient-correction-session.test.ts test/text/first-time-intake-setting.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check`:18 passed, zero failures/skips. Tracked `Abby correction setting migrated persistent and UI source qualification`, log `4590eee3-1791917779400.log`. Includes actual upgrade/default behavior, restart, clinic CAS, safe-mode denial and refusal to roll back public audit history.
- `npx playwright test test/browser/dashboard.spec.ts --grep 'E2E-363|E2E-255'`:5 passed, zero skips. Tracked `Abby correction setting browser controls and neighbouring intake qualification`, log `4590eee3-1791917939947.log`. New correction admin/shared-location/role/audit behavior and four adjacent intake cases pass with the unchanged two-worker browser configuration.
- `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && ABBY_LEDGER=postgres node --test --test-concurrency=4 test/composition/reference.test.ts test/storage/postgres-clinic-intake-setting.test.ts test/text/first-time-intake-setting.test.ts test/cliniko/patient-correction-session.test.ts test/contract/scenario-manifest.test.ts && git diff --check'`:42 passed, zero skips. Tracked `Abby correction setting migrated policy and existing preference regression`, log `4590eee3-1791917940201.log`. The preliminary memory-only composition run had26 passes and3 database cases skipped; it is not substituted for this complete PostgreSQL run.

Earlier failures: initial typecheck found three PolicyStore test delegates missing the new methods (`4590eee3-1791917025165.log`); they now forward to the real store. The migration rollback test first called an invariant untyped migration directly (`4590eee3-1791917564940.log`), then requested an unsupported typed migration target (`4590eee3-1791917652352.log`). It now uses the actual generic migrator's one-step rollback and upgrade, with the original history-preservation assertion. No runtime/source gate or assertion was weakened. Initial code generation produced no new table until migration043 was explicitly registered; the corrected generator completed in `4590eee3-1791916861942.log`.

Manifest1.171 tracks363 stable IDs and maps the new setting/admin commands to E2E-363. This is source/database/browser qualification. Ordinary correction voice/runner routing, concrete account-wide contact invalidation, correction process-loss review, setting-history export/import, required registration fields and resends remain gap8 work. Gap6 recurrence/historical sources, gaps9–13 and real clinic/mail/model/acoustic/cloud qualification remain open. The complete thirteen-gap objective stays active.


## Gap8 durable contact revision and proof/index synchronization

Migration044 adds account contact revisions and pending-change tokens. The trusted account owner supplies the complete configured credential fingerprint set; Abby does not infer that two keys belong to one account. A correction atomically advances all configured aliases and persists a random pending token before a possible PATCH. Exact native inspection consumes only that correction token and advances revisions again. Other concurrent tokens retain the block. Lost/uncertain writes do not expire or clear on restart. Integer exhaustion rolls the entire alias transaction back. New tables hold only tenant, credential fingerprint, revision, random token and timestamp; no patient ID, contact value, call/session or value digest.

Completed phone indexes and staged scans retain their captured contact revision. Index freshness/candidates deny pending or changed account revisions. Complete scans capture before their native read; staged scans capture at start and persist across resume. Publication locks account before clinic and compares the captured revision under that lock. A pre-correction scan cannot adopt a later revision or revive old phone mappings after unblock. A new complete scan is required. Tenant and unconfigured-account isolation are preserved.

Registered-email verification captures the private contact revision in its challenge, unconsumed grant and attested proof, checking it before and after fresh contact and independent permission reads. Codes/grants unused while the index is stale remain invalid after a refresh. The newly created patient booking proof also retains this revision; creation cannot bypass revocation. The compiled runner injects a PostgreSQL revision owner for its configured credential into every clinical host, including multiple location routes. Additional credentials require explicit complete account alias provisioning.

The correction session now requires the same account owner as its concrete registered-channel verifier. The prior generic success callback is removed. Failure to persist a fence stops PATCH; unknown write or completion failure retains review status and the durable block. The normal source verification grant is consumed before native mutation; post-send inspection remains limited to that exact pending transaction and fresh independent permission.

Qualification so far:

- Migrated isolated schema generation: `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && npm run db:generate'`, terminal success, log `4590eee3-1791918940561.log`. Generated files remain generated.
- `npm run typecheck && npm run build:voice-tests && git diff --check`, terminal success, log `4590eee3-1791919373413.log`.
- `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/storage/postgres-cliniko-contact-revision.test.ts test/storage/postgres-patient-phone-index.test.ts test/cliniko/email-patient-authority.test.ts test/cliniko/patient-correction-session.test.ts test/cliniko/intake-booking-session.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check'`:57 passed, zero failures/skips, log `4590eee3-1791919502677.log`. Includes real PostgreSQL alias/clinic isolation, concurrent pending changes, restart, complete/staged scan races, unused codes/grants/issued proofs and overflow rollback. Correction owner fixtures in this preliminary run used the synthetic revision owner.
- `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/voice/standalone-clinical-runner.test.ts test/voice/integrated-clinical-runner.test.ts'`:15 passed, zero failures/skips, log `4590eee3-1791919502902.log`. Actual compiled signed HTTP/WebSocket runner and inherited existing workflow behavior; this is synthetic transport evidence, not ordinary correction voice coverage.

- `npm run typecheck && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/patient-correction-session.test.ts test/cliniko/email-patient-authority.test.ts test/cliniko/intake-booking-session.test.ts test/contract/scenario-manifest.test.ts && git diff --check'`:33 passed, zero failures/skips, log `4590eee3-1791919628436.log`. The correction session fixture now uses the actual PostgreSQL revision owner in isolated database runs. This checks the full separately confirmed/reviewed native PATCH lifecycle, durable success/unknown/completion-failure states, failure to save the fence before PATCH, and rejection of a verifier bound to another owner. These are source/private-owner checks, not ordinary correction voice qualification.

Initial type qualification (`4590eee3-1791919213369.log`) exposed a wrong test database import, prohibited test constructor parameter properties, and too narrowly inferred synthetic-store return types. These setup errors were corrected without changing production limits or weakening assertions.

Manifest1.172 tracks364 stable scenarios. Ordinary correction voice/runner input remains unwired. Correction-specific process-loss/native-review recovery, operator resolution of durable uncertain changes, setting-history export/import, required registration fields and confirmation resends remain gap8 work. Gap6 recurrence/historical sources, gaps9–13, and real clinic/mail/model/acoustic/cloud qualification remain open. The complete thirteen-gap objective stays active.


## Gap8 ordinary correction caller flow and independent private playback

Patient updates now select their own admitted workflow. Its factory captures independent registered-channel caller approval and builds the concrete verifier, correction policy, account revision owner and native review writer. Clinic-wide correction preference and patient/action permission remain separate from booking and registration. A host must supply a dedicated private transcription adapter; a configured correction workflow cannot silently fall back to public field collection. The runner accepts a complete trusted credential fingerprint alias set, requires its configured credential to be included, and passes the same PostgreSQL owner into every clinical host.

The private input owner plays approved account-wide terms before accepting consent, offers only approved fields, decodes values privately, supports email spelling fragments and explicit continuation, and completes private readback. An email correction requires a separate code to the proposed address. During both code phases media is discarded. A separate played prompt and fresh keypad transition reopen ordinary speech through the existing quiet-audio fence. The caller then prepares an opaque-reference proposal and separately affirms the played SAM confirmation. This produces one reviewed/inspected patient PATCH; appointment writes and notifications are not created.

Correction private playback has its own core transition and preference/capability guard. Registration playback keeps its existing independent guard. Prompt text stays in transient playback storage; ledger/audit rows contain presentation/session metadata only. Local contact routing keeps inline values out of model requests and retains urgent, financial and caller-identity priority. Repeated preparation after a committed or uncertain action reports the existing outcome without replay.

Qualification:

- `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/voice/patient-correction-runner.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/integrated-clinical-runner.test.ts test/cliniko/patient-correction-session.test.ts test/cliniko/email-patient-authority.test.ts test/cliniko/intake-booking-session.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`:54 passed, zero failures/skips, log `4590eee3-1791921552788.log`. Includes five new compiled signed calls, private email fragments, separate registered/prospective codes, readback, confirmation, inspected postcode/email update, unknown-result retention, permission withdrawal and consent decline, alongside existing workflows.
- Explicit two-credential runner provisioning plus existing structured-model workflow regressions:13 passed, zero failures/skips, log `4590eee3-1791921921382.log`, with typecheck/build/diff. Both aliases advance to2 on exact inspected completion and retain version1 plus separate pending rows after an unknown PATCH. Default existing runner provisioning remains supported.

- Final routing/priority, configured-alias calls and structured-model regressions:14 passed, zero failures/skips, log `4590eee3-1791922721589.log`, with typecheck/build/diff. The mixed card-disclosure guard, recognized medical-emergency and identity-disagreement rules, private routing values and all five compiled correction cases pass on the final runtime source.

Earlier red witnesses and corrections:

- Initial typecheck found a prior four-workflow model-test helper using the now expanded workflow union (`4590eee3-1791920346134.log`). That helper now explicitly types its four tested operations; its cases and assertions remain intact. A later test predicate returned boolean-or-undefined (`4590eee3-1791920651867.log`); it now returns an explicit boolean.
- All three initial compiled correction calls failed before consent playback (`4590eee3-1791920838208.log`). The reused registration playback transition required registration activation. Correction playback now checks its own capability/preference. The audit switch then required the new metadata-only transition (`4590eee3-1791920978571.log`); exhaustiveness is restored.
- After this repair, postcode and lost-result calls passed, while email remained stuck after prospective-code entry (`4590eee3-1791921188399.log`). Awaiting playback inside the serialized keypad handler prevented its mark from being processed. The private input now returns promptly and owns the asynchronous receipt; premature digits remain private. Four call cases then passed in `4590eee3-1791921345559.log`.
- The routing-priority test initially used an emergency phrase outside the existing finite urgent classifier (`4590eee3-1791922452716.log`), then exposed mixed card-number disclosure bypassing the complete-request financial matcher (`4590eee3-1791922675184.log`). The test uses the existing supported medical-emergency and identity-disagreement cues; explicit card-number disclosure is now rejected before contact routing without entering model or message content. Financial protection is strengthened, not bypassed.

Manifest1.173 retains365 stable IDs. E2E-365 is synthetic signed/compiled voice evidence, not real acoustic, model, clinic, sender/mailbox or carrier acceptance. Further correction collection/review refinements, correction-specific process-loss/native-review recovery and operator resolution of uncertain durable account changes, setting-history portability, required intake fields and resends remain gap8 work. Gap6 recurrence/historical sources and gaps9–13 remain open. The full thirteen-gap objective stays active.


## Gap8 durable review binding and authenticated recovery

The native pre-send review and durable contact block previously used different random references. They now share the correction reference. Migration045 records the complete configured alias set and a non-reusable reference, then retains completed attribution. The registry stores no patient IDs, native recall IDs, notes, correction values or value digests. Pending blocks survive restart; no timeout releases them. Migration backfills older pending references as `legacyUnlinked`, preserving every alias block without authorizing native-review recovery. Retained reference history prevents destructive rollback and reference reuse.

The privileged recovery service requires a live authenticated clinic administrator from the current directory, independently approved recovery, an exact closed native review, and host-owned confirmation of investigation and sender/provider quiescence. It rereads the native review and current authority before clearing only the linked local block. Merely marking a recall as recalled does not grant resolution. The [official Cliniko Recall API](https://docs.api.cliniko.com/openapi/recall) provides the exact `GET /recalls/{id}` used here; the bounded reader checks patient/type/self links and shared request budget. No patient PATCH, recall mutation, replay or original-caller success claim is performed by recovery.

The embedding host may mount `POST /api/patient-corrections/resolve-reviewed` through its authenticated dashboard identity. Role, exact origin, body shape, current actor and independent service authority are checked; the limited availability-setup surface excludes it. No default production identity, review investigation/quiescence implementation or operator workflow is provisioned by this change. Actual clinic/operator acceptance remains required.

A parent synthetic Cliniko provider and actual PostgreSQL survive four child SIGKILL checkpoints: before fencing, during native send, after send and after synchronization. The child executes actual private correction verification, host proposal, played SAM confirmation and effect dispatch. Replacement native discovery and authenticated recovery do not create another PATCH. Concurrent blocks, revoked identity/permission, changed native reviews, malformed links, legacy references and repeated completion retain their expected boundaries.

Qualification:

- Schema generation against migrated disposable PostgreSQL: `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && npm run db:generate'`, passed, log `4590eee3-1791923569008.log`. Generated schema files were not hand-edited.
- Typecheck and migrated source/native-owner regressions:21 passed, zero failures/skips, log `4590eee3-1791924135947.log`.
- Typecheck, compiled voice/dashboard builds and crash/recovery/source tests:23 passed, zero failures/skips, log `4590eee3-1791924868903.log`.

- Final migration/HTTP/crash and compiled-caller regression: `npm run typecheck && npm run build:voice-tests && npm run build:dashboard && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/patient-correction-process.test.ts test/cliniko/patient-correction-recovery.test.ts test/storage/postgres-cliniko-contact-revision.test.ts test/storage/postgres-contact-change-registry-migration.test.ts test/storage/postgres-patient-correction-setting.test.ts test/cliniko/patient-correction-session.test.ts test/cliniko/recalls.test.ts test/voice/patient-correction-runner.test.ts test/text/patient-correction-setting.test.ts test/text/dashboard-listener-origin.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`:53 passed, zero failures/skips, log `4590eee3-1791925327431.log`. Includes the real044-to045 migration and older-setting rollback assertions, setup-only HTTP exclusion, four SIGKILL checkpoints and five existing compiled correction calls.

Corrected failures and compatibility:

- Initial crash-fixture typecheck failed on TypeScript narrowing of a record assigned by an asynchronous callback (`4590eee3-1791924656310.log`). A record accessor and explicit fixture types restore checking; no assertion, worker count or deadline was weakened.
- The correction-setting migration test assumed its migration was always latest. It now targets schema042 explicitly, preserving both older-schema refusal and retained-history rollback assertions. A separate real044-to045 migration test verifies legacy block preservation, refusal of staff resolution and retained completed reference history.

Manifest1.174 adds E2E-366 as source/SAM/process evidence. Correction acoustic/model/carrier evidence is not promoted. Gap8 private collection refinements, production operator integration/acceptance, setting-history portability, required intake fields and resends remain open, alongside gap6 recurrence/historical sources and gaps9–13. The full thirteen-gap objective remains active.


## Gap8 correction edits after private readback and preparation

The private correction input previously closed its media controller after readback and offered only a return to speech. It now offers field edits or a complete reset after readback, and reserves those edit keys for the current correction workflow after speech resumes. Before any prospective-code digits, pound also returns to edits. Each edit creates a fresh private transcription session after stopping the previous controller; old/queued audio remains behind the private transport boundary.

Entering edits immediately withdraws the prior private correction reference, host action evidence and prospective email challenge. The metadata-only private-correction presentation cancels unsent correction actions and pending write effects. A dispatched, committed, uncertain or review-required correction cannot enter a new private prompt. After recollection, a new readback, any required prospective-email proof, a new preparation and a separately played SAM confirmation are required. Editing retains the existing three-collection and code-attempt budgets; it supplies no new permission or retry authority.

The direct source tests verify that an old prepared/ready write and prospective code fail after withdrawal, collection limits remain enforced and a possible native send cannot be reopened. Four compiled signed caller journeys exercise edits after readback, after played preparation and during prospective email verification, and full reset of a multi-field draft. They inspect canceled action state, exactly one final native PATCH with revised fields, one native review, no appointment write and no corrected values in public model requests or local storage/output.

These are synthetic source/compiled caller checks. Real acoustic correction/interruption quality, clinic/operator acceptance, required intake fields, confirmation resends and setting portability remain open. Gap6 recurrence/historical sources and gaps9–13 remain part of the active full objective.

Initial qualification and corrections:

- `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/patient-correction-session.test.ts test/voice/patient-correction-edit-runner.test.ts test/voice/patient-correction-runner.test.ts test/text/patient-correction.test.ts' && git diff --check`:25 passed, zero failures/skips, log `4590eee3-1791926230160.log`.
- Initial red witness `4590eee3-1791925965901.log` found a fresh private-media controller receiving the old frame sequence. Each new controller now resets its own sequence while retaining strict ordering and a distinct session/generation. The source test now asserts the canceled worker's actual `invalidTransition` rejection and direct host refusal; no mutation assertion was removed. The compiled fixture now exposes only the actual transient last-action status, replacing an incorrect assumption that standalone transient calls were persisted in PostgreSQL. No deadline, worker count or test gate was weakened.

Final qualification: `npm run typecheck && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/patient-correction-session.test.ts test/voice/patient-correction-edit-runner.test.ts test/voice/patient-correction-runner.test.ts test/voice/private-keypad-verification.test.ts test/voice/private-keypad-verification-postgres.test.ts test/voice/private-intake-spelling.test.ts test/voice/keypad-availability.test.ts test/text/patient-correction.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`:43 passed, zero failures/skips, log `4590eee3-1791926472215.log`. The runtime and fixture source are unchanged from the freshly compiled preceding green gate. Includes four edit/reset and five existing compiled correction calls, lost-send denial, source reference/code invalidation, budgets, private keypad/draining, first-time spelling/registration and manifest/trace contracts. Manifest1.175 adds E2E-367; carrier/full-call evidence remains planned.


## Gap8 correction-setting history portability

The correction preference already had an independent clinic-wide store, but tenant configuration export/import omitted it. The archive now carries one strict public correction history per clinic. Version continuity, previous values, head uniqueness, actor references, timestamps and exact row fields are checked; unknown/private fields, corrupted native or retained histories and omitted source clinics are refused. Legacy absence means disabled version zero. Timestamps normalize to equivalent UTC instants before native/reference history comparison.

Reference single-location/tenant and PostgreSQL imports retain the source history. An enabled source gains exactly one separately attributed target disable, shared across locations. A disabled or legacy source gains no audit event. Import retry returns the same durable receipt and does not append another disable. A correction-only target is occupied and cannot be overwritten. No patient values, proofs, private drafts, consent or independent clinical permissions are copied.

Settings digests now include correction history, so source drift is visible in normal/fenced archive snapshots. Native target reconciliation includes exact correction rows, import attribution/time and tenant-wide counts; changed audit metadata and rows under unlisted target clinics deny readiness. Reconciliation uses the existing reference-profile cutover contract. Minimal-mode PostgreSQL imports and reference imports are separately checked for preference/history parity and disabled patient-update capability. This change does not claim minimal-profile telephone cutover or real-clinic activation.

Qualification and corrections:

- Initial typecheck (`4590eee3-1791927056426.log`) found a shadowed fixture variable; the final source-enabled argument now has a distinct name. No runtime test executed in that failed run.
- The next source/database gate (`4590eee3-1791927187126.log`) passed typecheck and15 of17 checks. Two new tests assumed an `alreadyStaged` return instead of the retained stage receipt, and invoked the reference-profile reconciliation function against minimal stored policies. The retry test now checks exact receipt equality and native row count; the reconciliation test uses the same explicit profile as existing number-cutover tests. Mutation, target-disable and tampering assertions remain.
- Focused corrected PostgreSQL qualification:6 passed, zero failures/skips, log `4590eee3-1791927362808.log`.

This closes the locally implemented correction-preference/history carryover portion of gap8. Required intake fields, confirmation resends and production recovery-host/operator integration/acceptance remain open. Gap6 recurrence/historical sources and gaps9–13 remain part of the full active objective. Current exact-head cloud and actual clinic/mail/model/acoustic/carrier evidence remain separate gates.

Migration046 adds the existing tenant portability guard and truncate-rejection triggers to the correction-setting table, including upgrades over existing history. This closes a missing freeze binding in migration043. Frozen native preference edits, raw update/delete, truncate and guard rollback are refused; authorized release permits later writes, and downgrade/re-upgrade preserves history. No table columns changed, so existing generated types remain valid without regeneration.

- Broader pre-guard source/archive/carryover/cutover gate:46 passed, zero failures/skips, log `4590eee3-1791927474844.log`.
- Initial guard gate (`4590eee3-1791927656370.log`) passed typecheck and57 of58 checks. The new fixture supplied the freeze reason to the release call; the existing contract requires `cutoverRelease`. The fixture now uses that reason, with no guard or assertion weakened.
- Final qualification: `npm run typecheck && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/storage/postgres-patient-correction-carryover.test.ts test/storage/postgres-clinic-intake-carryover.test.ts test/storage/postgres-minimal-config-archive.test.ts test/storage/postgres-config-archive.test.ts test/storage/postgres-notification-carryover.test.ts test/storage/postgres-voice-carryover.test.ts test/storage/postgres-fenced-final-archive.test.ts test/storage/postgres-number-cutover.test.ts test/storage/postgres-portability-fence.test.ts test/storage/postgres-patient-correction-setting.test.ts test/storage/postgres-contact-change-registry-migration.test.ts test/text/patient-correction-setting.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`:59 passed, zero failures/skips, log `4590eee3-1791927766924.log`. Includes eight new carryover/guard checks and earlier contact-registry migration compatibility, plus existing intake, notification, voice, normal/fenced archives, number-cutover, settings and registry/trace checks.

Manifest1.176 adds E2E-368 as configuration/source/PostgreSQL evidence and maps it to correction preference/audit commands. Voice and full-call evidence remain planned for this configuration scenario. The full thirteen-gap objective stays active.


## Gap8 clinic-required registration fields

The previous intake contract fixed requiredFields to six fields and privately collected only name, birth date and email; the admitted phone/type supplied the other two. Independently approved intake policy can now require seven native address fields: address lines1–3, city, state/county, postcode and two-letter country code. The original six remain mandatory. Unsupported, duplicate or missing requirements are refused; drafts must contain exactly the approved set. The [official Cliniko Patient API](https://docs.api.cliniko.com/openapi/patient) documents these fields in patient creation. This change does not collect clinical notes, marketing preferences, financial identifiers or arbitrary custom fields.

Private voice collection uses the current captured approval's field plan and deterministic private parsing. Empty/removal values cannot satisfy a required field. Complete private readback includes every required value; longer legal drafts use bounded chunks without skipping fields or extending the existing deadline. Prospective email proof and separately played SAM registration confirmation remain separate. A successful registration still needs independent booking permission and its own subsequent booking confirmation.

Private host evidence rebuilds all allowlisted draft fields on preparation and re-attestation. Optional fields removed from fresh evidence cannot survive in the cached request. The transient digest binds every supplied native field. Patient creation sends only those fields and checks them in both the creation response and a fresh exact patient read; missing or changed observations leave the result uncertain without replay or a new booking proof. Reference-only SAM/model inputs and privacy-limited persistence remain unchanged.

Source tests cover current/required fields, unapproved additions, missing fields, approval withdrawal, private full/chunked readback, digest binding and changed/removed evidence, malformed/unsupported provider fields and uncertain response/inspection. Four compiled signed journeys cover complete registration plus separate booking, an unsatisfied required field, permission withdrawal and additional-field inspection mismatch. They inspect exact native bodies, private transcript/model/storage boundaries and absent booking for unproven creation.

Initial typecheck log `4590eee3-1791928504914.log` found narrowing of a mutable unknown property inside a callback; the decoder now captures the required-fields array in a local constant before checking it. No runtime test or live provider call ran in that failed gate.

This is engineering/source/synthetic caller evidence. Actual clinic schema acceptance, real acoustic/model/recipient/carrier qualification, confirmation resends and production recovery-host/operator integration remain open. Unsupported clinic-specific fields require an explicit adapter; they are not silently ignored. Gap6 recurrence/historical sources and gaps9–13 remain part of the full active goal.

Correction/qualification history:

- `4590eee3-1791928670842.log`:typecheck and fresh compiled build passed;57 of58 checks passed, including all four new compiled cases. An existing host-envelope binding case failed because validation was applied before selecting the private draft fields. Trusted runtime metadata now follows the existing projection contract while supplied registration fields remain bound and refreshed; caller/provider payloads and approved required-field sets remain strict. The original regression assertions are intact.
- Restored-envelope focused source gate:41 passed, zero failures/skips, log `4590eee3-1791928892145.log`, using `node --test --test-concurrency=4 test/cliniko/transient-intake-authority.test.ts test/cliniko/required-intake-fields.test.ts test/cliniko/patient-intake.test.ts test/cliniko/intake-clinic-policy.test.ts test/cliniko/caller-mediated-intake.test.ts`.

Final qualification: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/required-intake-fields.test.ts test/cliniko/patient-intake.test.ts test/cliniko/intake-clinic-policy.test.ts test/cliniko/caller-mediated-intake.test.ts test/cliniko/transient-intake-authority.test.ts test/cliniko/intake-booking-session.test.ts test/cliniko/intake-booking-postgres.test.ts test/voice/required-intake-runner.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/private-intake-spelling.test.ts test/voice/patient-correction-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`:80 passed, zero failures/skips, log `4590eee3-1791929092245.log`. Includes four required-field compiled calls,13 existing compiled clinical cases, five correction calls,16 private spelling modes and native/PostgreSQL downstream-permission regressions. Complete wait/closing controls cannot become required address values. Manifest1.177 registers E2E-369 and maps it to the existing reference-only intake proposal capability; no public field/value collection capability is added.

## Gap8 confirmation-resend SMTP foundation

The prior goal turn was list-only and produced no implementation. Current worktree HEAD was revalidated at `d7faa21d6e123263056ad38d9fa180c3dc768e24`; no live job was present before this qualification. This turn implements the private transport needed for a genuine independently authorized resend. The full thirteen-gap objective remains active.

The [official Cliniko individual-appointment API](https://docs.api.cliniko.com/openapi/individual-appointment) was checked on October13: its documented operations do not include a confirmation-resend endpoint. This implementation uses a separate SMTP adapter; it does not patch/create an appointment or patient to provoke native email.

- `src/standalone/smtp-text-mail-transport.ts` extracts the existing implicit-TLS/AUTH-PLAIN transport, retains certificate/name validation and bounded transaction/reply handling, and returns accepted, definitely-unsent or unknown submission results. Once the body might have crossed the socket, a lost/malformed/unexpected acknowledgement, abort or deadline is unknown. An explicit SMTP rejection is unsent. Known250 acceptance is server acceptance, never inbox delivery. Each invocation submits at most once, without retry.
- `src/standalone/smtp-patient-code-delivery.ts` keeps its code-only public interface and message. It maps unknown submission to unverified delivery and does not send appointment content.
- `src/standalone/smtp-appointment-confirmation-delivery.ts` renders an exact private DTO into fixed appointment details: clinic/location/address, appointment-local date/time, elapsed duration, practitioner and appointment type. It refuses unknown fields, malformed recipient/times/zone, empty/unbounded labels and control-character injection before SMTP. Unicode uses bounded MIME encoding. It accepts neither a verification code nor arbitrary subject/body instructions.
- `test/cliniko/smtp-appointment-confirmation-delivery.test.ts` uses synthetic real loopback TLS/SMTP for14 cases covering local/DST time rendering, content/recipient boundaries, MIME, certificate failure, rejection, lost/unexpected acknowledgement, abort/deadline and dot transparency. The SMTP fixture adds explicit post-body rejection/unexpected-reply faults without weakening existing verification assertions.

Initial qualification `Abby confirmation SMTP transport focused qualification`, log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791930090535.log`, passed typecheck and25of26 tests. The only failure was the expected locale date string omitting the comma returned by `Intl.DateTimeFormat("en-GB")`; the exact-content assertion was corrected to the actual localized date. All existing12 verification-delivery cases passed, including the actual caller proof/protected-read journey.

Final qualification passed typecheck, fresh compiled build, diff check and83 tests with zero failures/skips: `npm run typecheck && npm run build:voice-tests && node --test --test-concurrency=4 test/cliniko/smtp-appointment-confirmation-delivery.test.ts test/cliniko/smtp-patient-code-delivery.test.ts test/cliniko/email-patient-authority.test.ts test/text/notification-policy.test.ts test/text/notification-effects.test.ts test/voice/notification-outcome-query.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check`, tracked job `Abby confirmation SMTP resumed qualification October14`, log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791937144312.log`, terminal exit0. This includes14 new adapter cases,12 existing SMTP verifier cases, patient-authority/current-revision regressions, notification ownership/effects and signed notification-question/SAM/privacy cases, plus registry/trace contracts. The preceding run `4590eee3-1791930209566.log` was confirmed orphaned with no remaining process after interruption and had stopped during typecheck; it supplies no qualification evidence. The unchanged corrected source was then rerun under a tracked user-systemd scope.

Manifest1.178 registers E2E-370 as transport/source evidence only. This adapter does not authorize a resend or enforce durable idempotency across invocations/restarts. Next work is the dedicated current clinic/caller permission, fresh exact appointment and registered-recipient resolution, played resend consent, durable send fence/review and SAM/compiled caller routing. Read-only notification questions still create no send. Automatic notification ownership is unchanged. No real sender/mailbox or clinic/carrier acceptance is claimed. Gap8 remains incomplete; gap6 recurrence/historical sources and gaps9–13 remain open, alongside cloud/clinic/mail/model/acoustic qualification.

## Gap8 independent resend approval and durable submission barrier

The prior goal turn made progress: private fixed appointment SMTP transport was qualified with83 checks and published as `04054a6b58f7bf614bd27084895f78f2b0f0a2e6`. That HEAD and a clean worktree except the existing `node_modules` link were revalidated before this work; no live tracked job was present. Full13 scope is retained.

- `appointments.resend` is a distinct registered-channel patient proof operation. The actual email-code verifier can issue it only under the clinic-approved method and independent patient/action permission; an appointment-read grant cannot authorize this operation. No public command or caller workflow is added yet.
- `OwnerFileConfirmationResendPolicy` requires a separately approved/current administrator source bound to clinic/location, policy version, Cliniko account/business/time zone, sender and recall type. Its exact contract fixes Abby ownership, appointment-details template, verified registered recipient, independent patient permission, separately played consent, durable single attempt and full-type Cliniko review process with distinct owner/backup/cadence. Changed/disabled source, membership, expiry or a mismatched binding is unavailable; a verification-mail sender or automatic notification preference cannot authorize this action.
- Migration047 adds `confirmation_resend_journal`; it is registered in the actual migration runner. Kanel generated the new table type and schema membership against a fresh migrated PostgreSQL17 database. Each scoped record contains random request/message references, an owner-configuration fingerprint and submission status/times. It contains no native patient/appointment ID, email, message content, call/session, proof or patient-value digest. Tenant freeze guards cover writes/truncation; downgrade refuses retained history or a frozen tenant.
- `PostgresConfirmationResendJournal` atomically claims a logical request once. Racing requests, fresh stores, changed owner bindings and another clinic/location cannot reuse it. Accepted, definitely-unsent and unknown outcomes cannot reopen the barrier; contradictory completion is refused. A pending claim after process loss is uncertain, without retry.
- `DurableConfirmationSubmission` is a trusted private host port: it clones private content before awaiting, validates the claim, crosses the durable barrier before SMTP, preserves unknown outcomes after transport/storage exceptions and never resends an existing reference. It grants neither permission nor played consent and is not exposed as a model/caller tool. The later evidence owner must establish recipient/details/current authority, consent and native review before invoking it.

Correction/evidence history:

- Initial generation `4590eee3-1791937747309.log` did not include the new table because the explicit migration registry had not yet been extended; it supplies no new-table qualification. Migration047 was registered, then `npm run db:migrate && npm run db:generate` completed against fresh PostgreSQL, tracked log `4590eee3-1791937892110.log`.
- Initial focused gate `4590eee3-1791937789295.log` stopped at typecheck: the union result needed explicit status projection, and direct migration tests required generic Kysely migration signatures. No runtime tests ran in that failed gate. Both were corrected without casts or changed assertions.
- Corrected source/native gate `4590eee3-1791937960703.log`, `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-policy.test.ts test/storage/postgres-confirmation-resend-journal.test.ts test/cliniko/caller-verification-session.test.ts test/cliniko/email-patient-authority.test.ts test/storage/postgres-contact-change-registry-migration.test.ts'`:32 passed, zero failures/skips, terminal exit0. Includes four new approval/proof cases and eight new native journal/submission cases, alongside existing caller/authority and contact-registry upgrade/retention tests. Concurrent status observers may truthfully observe accepted or unknown; one actual SMTP message, rather than the number of accepted observers, determines duplicate prevention.
- Final qualification passed typecheck, fresh compiled build, diff check and106 tests with zero failures/skips: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-policy.test.ts test/storage/postgres-confirmation-resend-journal.test.ts test/cliniko/caller-verification-session.test.ts test/storage/postgres-contact-change-registry-migration.test.ts test/storage/postgres-patient-correction-setting.test.ts test/cliniko/smtp-appointment-confirmation-delivery.test.ts test/cliniko/smtp-patient-code-delivery.test.ts test/cliniko/email-patient-authority.test.ts test/text/notification-policy.test.ts test/text/notification-effects.test.ts test/voice/notification-outcome-query.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`, tracked job `Abby resend policy durable journal final qualification`, log `4590eee3-1791938057178.log`, terminal exit0. Includes the12 new policy/journal cases and existing registered-proof, SMTP/notification/SAM/privacy, migration and registry contracts. Existing tests retain their original assertions, worker count and deadlines.

Manifest1.179 registers E2E-371 as source/native-port evidence only. Fresh exact native appointment/verified-recipient assembly, separately played caller consent, native review binding/recovery, SAM/compiled caller routing and serving activation remain to implement; the public notification-question route remains read-only. No actual process SIGKILL, carrier/acoustic/model, real clinic sender/mailbox or production operator acceptance is claimed by these fresh-store/native tests. Journal history cutover/recovery ownership still needs qualification before activation. Gap8 remains open, alongside gap6 recurrence/historical sources, remaining clinic-specific field adapters/operator acceptance and gaps9–13. Current-head cloud qualification and real clinic/mail/model/acoustic/carrier gates remain separate.

## Gap8 private native resend evidence and reviewed submission

Previous goal turn: progress. HEAD `b31a53b444ddfbec8e7774dbc726767876f20e66` and the worktree were revalidated with no live job before editing. Full13 scope is unchanged.

The [official business](https://docs.api.cliniko.com/openapi/business), [practitioner](https://docs.api.cliniko.com/openapi/practitioner), [appointment type](https://docs.api.cliniko.com/openapi/appointment-type) and [individual appointment](https://docs.api.cliniko.com/openapi/individual-appointment) schemas were checked on October14. The private evidence reader uses exact native GETs and declared identity/relationship/time-zone/name/address fields; it does not follow supplied arbitrary URLs or mutate appointment/patient records.

`ClinikoConfirmationEvidenceReader` binds the real admission/session, current owner approval, account and shared contact-revision owner to resend-specific registered-channel proof and independent patient permission. Active call/lease, caller-identity denial, policy version, write stop and source validity are rechecked. Exact appointment patient/business/practitioner/type links, active status and interval are checked, metadata and registered recipient are read fresh, and the selected target is reread before returning transient evidence. Private mail fields remain outside public model/SAM and persistence. A new trusted `verifiedSubject` method checks the configured operation and refreshes proof once; it exposes no model/caller endpoint.

`ClinikoConfirmationResendSession` binds the approved sender/template and journal owner. It privately plays complete recipient/details readback, rereads the evidence and returns only a random request reference. A separate trusted `isConfirmed` port is mandatory; verification/readback cannot satisfy it. Confirmed private dispatch opens an acknowledged Cliniko review and checks exact evidence/authority before and after that write. It then crosses the PostgreSQL barrier and checks authority again after the claim, before SMTP. Withdrawal during claim therefore remains definitely unsent. Drift, failed playback, wrong proof/source/scope, uncertain review and permission loss cannot send; the live owner consumes one dispatch and never replays it.

The review protocol adds a strictly validated `confirmationResend` operation and dedicated header, retaining existing headers. The same resend UUID is carried in native review context, the durable journal and SMTP Message-ID so staff can investigate even a lost SMTP acknowledgement. No email/body is added to Cliniko review notes or local state. Accepted delivery references must match the intended submission reference; a mismatched result is unknown. The discovery worker counts the new kind without changing older zero-count output.

Nine new source/native-owner cases use the actual registered verifier, real PostgreSQL contact revision/journal, synthetic native HTTP and loopback TLS SMTP. They cover linked one-send acceptance, private readback without consent, playback/drift/source withdrawal, bad native relations/status/labels/time zone, read-grant denial, uncertain review/permission loss, revocation during durable claim, lost mail acceptance and foreign/closed construction. These use a trusted test confirmation port, not an implemented SAM confirmation handler.

Qualification history:

- `4590eee3-1791939424441.log`: initial typecheck stopped at the existing discovery worker's exhaustive operation counter. The new kind received its own aggregate counter, preserving old output. No runtime tests ran.
- `4590eee3-1791939545429.log`:46 of47 source tests passed; all nine new native-owner cases passed. An existing SMTP case's100ms transaction deadline expired before body submission under load, contradicting its assumption that every such timeout occurred after DATA. The test now asserts the observed phase: no acceptance, mandatory unknown after received body, no body for definite non-send, and a DATA command for uncertain submission. Its100ms deadline, the explicit post-body abort assertion and production behavior remain unchanged.
- Final qualification passed typecheck, fresh compiled build, diff check and97 tests with zero failures/skips: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-session.test.ts test/storage/postgres-confirmation-resend-journal.test.ts test/cliniko/confirmation-resend-policy.test.ts test/cliniko/smtp-appointment-confirmation-delivery.test.ts test/cliniko/smtp-patient-code-delivery.test.ts test/cliniko/caller-verification-session.test.ts test/cliniko/email-patient-authority.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/review-discovery.test.ts test/cliniko/review-discovery-process.test.ts test/cliniko/recalls.test.ts test/voice/notification-outcome-query.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`, tracked job `Abby confirmation resend native owner final qualification`, log `4590eee3-1791939728726.log`, terminal exit0. Includes nine new native-owner cases, SMTP/journal/approval/proof regressions, old review protocol/send/discovery and actual killed-sender recovery compatibility, signed notification status/privacy and manifest/trace checks.

Manifest1.180 adds E2E-372 as source/native-port evidence only. The evidence owner is not connected to a public caller/model route. The actual SAM confirmation implementation, compiled signed caller/serving integration, resend-specific process-loss/operator recovery and journal history portability remain open. The currently approved template supplies upcoming appointment details; clinic-specific virtual/cancelled confirmation content and real recipient/sender/clinic acceptance still need explicit qualification. No real model/acoustic/carrier or current-head cloud completion is claimed. Gap8 and the full13 goal remain active; gap6 recurrence/historical sources, remaining clinic-specific fields/operator acceptance and gaps9–13 are not closed.

## Gap8 real SAM resend action and native host adapter

Previous goal turn: progress. Published HEAD `c1952f75f9df6278b5f53e93c491f50b26bc8d4a` was revalidated; no live tracked job was present. Full13 scope remains active.

Core now has a distinct optional `confirmationResend` capability and an exact reference-only action: scope, random request reference, current owner-configuration version and expiry. Legacy/missing/request-only capability cannot execute or create an implicit staff resend. The proposal requires the correct captured source binding, scope, bounded expiry and no extra patient/contact/content fields. Its generic confirmation must be played and separately affirmed under the normal SAM digest/effect rules. SMTP acceptance wording claims neither inbox delivery nor an appointment booking. It creates no automatic notification effect; a notification query reads the recorded resend action only.

`captureConfirmationResendPolicy` strips stored/unproven resend modes and versions, then captures execution only from a current actual owner-file approval matching the policy version. `notifications.resend.propose.v1` is a reference-only agent capability resolved again by the owning host; gateway schema denies additional fields, and current call/session/privacy checks remain. The public model/caller cannot provide recipient, email body, native appointment IDs or consent booleans.

`ClinikoSamConfirmationResendHost` composes the qualified private evidence/session with actual SAM state. Private readback is tracked as a blank notice with completed playback, then an independent generic confirmation is proposed. Native dispatch requires the exact action/digest/mutation, played speech presentation, active matching lease/session/admission, current source/mode and a dispatched/possibly-sent write effect. The private session's confirmation callback is supplied internally from those checks. Review and SMTP remain guarded by fresh native evidence/authority, including after the PostgreSQL claim. Reconciliation reads only the scoped durable submission receipt; it cannot inspect or replay an appointment or email write. PostgreSQL audit projection recognizes the private notice without storing its text.

Seven new core/native tests passed in the focused gate, including an actual gateway proposal, private/public SAM playback, separate affirmation, effect dispatch, native review and one real loopback SMTP message; withdrawal/source loss and unknown receipt-only reconciliation are also covered. Private values/codes/native subjects are absent from SAM/progress/local metadata. The admitted fixture now captures the approved source before admission and acknowledges the greeting before private playback, matching real serving order. The notification-query fixture uses the owner clock, retaining the lease check rather than substituting caller timestamps.

Correction/qualification history:

- `4590eee3-1791941098343.log`: first typecheck stopped at new private-event audit exhaustiveness, host ledger/booking-port types, two test interpretation names and an older four-operation voice fixture's overly broad workflow type. No runtime tests ran. These were corrected without removing any older scenario or assertion.
- `4590eee3-1791941360646.log`:13of16 passed; all four new core cases and nine prior private-owner cases passed. Three SAM/native cases stopped at the new overlap guard because their admitted greeting was still pending. The fixture now acknowledges that greeting through actual SAM playback before private readback.
- `4590eee3-1791941532947.log`:6of7 passed. The complete send journey reached its read-only status query, whose fixture incorrectly used the real date against the synthetic lease. All receptions now use the same trusted fixture clock; no lease duration changed.
- `4590eee3-1791941626167.log`:7 passed, zero failures/skips, terminal exit0, with `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-sam.test.ts test/text/confirmation-resend.test.ts'`.
- Final qualification passed typecheck, fresh compiled build, diff check and114 selected tests with zero failures/skips: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/text/confirmation-resend.test.ts test/cliniko/confirmation-resend-sam.test.ts test/cliniko/confirmation-resend-session.test.ts test/cliniko/confirmation-resend-policy.test.ts test/storage/postgres-confirmation-resend-journal.test.ts test/cliniko/smtp-appointment-confirmation-delivery.test.ts test/cliniko/caller-verification-session.test.ts test/text/patient-correction.test.ts test/text/notification-effects.test.ts test/cliniko/patient-correction-session.test.ts test/cliniko/catalogue-command-gateway.test.ts test/voice/notification-outcome-query.test.ts test/voice/clinical-model-workflow-call.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`, tracked job `Abby SAM resend final type build and regression`, log `4590eee3-1791941879902.log`, terminal exit0. Includes seven new core/native SAM cases, nine prior native-owner cases, source/journal/SMTP/proof, correction and gateway compatibility, existing signed clinical-model workflows/status/privacy, and manifest/trace contracts.

Manifest1.181 adds E2E-373 and maps the new proposal/status capabilities. This is actual SAM/source/native-port evidence, not signed resend-caller or carrier evidence. Full caller/workflow/compiled serving routing and private media ownership, resend-specific process-loss/operator recovery, journal history portability and clinic-specific virtual/cancelled confirmation content remain open. Real clinic/sender/recipient/model/acoustic/current-head cloud acceptance is separate. Gap8 and the complete13 objective are not achieved; gap6 recurrence/historical sources, remaining clinic-specific fields/operator acceptance and gaps9–13 are unchanged.

## Gap8 admitted resend workflow and private appointment selection

The admitted Cliniko call flow now composes a dedicated resend workflow. Its caller approval must explicitly enable `appointments.resend` before workflow creation, and its new registered-channel challenge grants only that operation. Independent recipient permission, the shared Cliniko contact revision, current owner approval and captured resend capability remain required. A plain appointment-read approval cannot start it.

The workflow reads the verified caller's upcoming appointments privately, plays up to three chronological choices through blank SAM notice records, and returns only a count. Selection consumes that private menu, rejects superseding turns, rereads the native list and compares the exact appointment identity and interval. Only then does the existing actual SAM resend host privately read the registered recipient and current details and return a random request reference. Preparation now propagates cancellation through the private native readback. No menu acceptance substitutes for the separate public confirmation and affirmative digest. Live call-flow reconciliation delegates to the existing durable receipt reader without a native read or another SMTP attempt.

Qualification so far:

- `4590eee3-1791942774565.log` and `4590eee3-1791942857029.log`: static failures identified a proof adapter with an extra argument, the fixture's optional database URL and duplicate synthetic appointment fields. No runtime evidence claimed for those gates.
- `4590eee3-1791943063770.log`: corrected typecheck and compiled build passed; native qualification passed14 of15 tests. The new negative case exposed that capturing a valid caller-policy file did not itself check its operation was enabled. Workflow creation now checks current operation approval before creating its verifier.
- `4590eee3-1791943322468.log`: three new native workflow tests passed, zero failures/skips, terminal exit0, with `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-workflow.test.ts'`. These cover an exact selection from two appointments through separate real SAM consent and one SMTP/native-review attempt, changed times, superseding turns, permission loss, failed/aborted playback, closed owners, independent caller-operation approval, receipt-only live reconciliation and public canary absence.

- Final qualification passed typecheck, fresh compiled build, diff check and54 checks with zero failures/skips: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-workflow.test.ts test/cliniko/confirmation-resend-sam.test.ts test/cliniko/confirmation-resend-session.test.ts test/cliniko/confirmation-resend-policy.test.ts test/storage/postgres-confirmation-resend-journal.test.ts test/cliniko/cliniko-call-flow.test.ts test/cliniko/caller-verification-session.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/notification-outcome-query.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`, tracked job `Abby resend workflow final source build and native regression`, log `4590eee3-1791943371880.log`, terminal exit0. After preserving the registry's compact format and limiting the new scenario to its actual standalone composition, both contract files and diff check passed again in `4590eee3-1791943562803.log`, terminal exit0. Manifest1.182 retains all previous stable IDs and adds E2E-374.

E2E-374 records native workflow evidence only. Explicit caller intent routing, private media transport and signed compiled serving composition remain open; this checkpoint does not claim a usable signed voice resend route. Paging beyond the first three choices, resend-specific process-loss/operator recovery, journal history portability, clinic-specific virtual/cancelled confirmation content and real clinic/sender/recipient/model/acoustic acceptance also remain. Gap6 recurrence/historical sources, remaining field/operator acceptance and gaps9–13 remain open. The full13 objective is not complete.

## Gap8 signed compiled resend caller route

Explicit appointment-email send requests now enter the independent resend workflow before public model inference. Missing-email and delivery-status questions retain their read-only path; supplied alternate recipients cannot select an email target. The clinical host recaptures actual resend approval on admission and current policy reads. A resend configuration requires its dedicated private playback port; existing hosts without resends retain their previous context shape.

The live private-input wrapper owns registered-channel OTP, privately spoken appointment choices, keypad selection and recipient/details readback. Those media frames never reach ordinary transcription. It returns to public media through the existing post-private quiet drain, then the caller explicitly prepares sending, hears the generic SAM confirmation and separately affirms it. Private tasks run outside the serialized wire queue so physical playback marks can complete. Blank native-owned notices are rendered by exact presentation ID, and their real transport receipts are accepted without overwriting terminal failures or resolving the same completion twice.

The compiled fixture exposed two integration defects beyond static typing. Spreading fixture resend configuration could override the newly admitted call's ownership; composition now passes actual admission/session/ledger/policies/provider/lifetime explicitly. A keypad choice immediately following completed playback could arrive before the final native authority refresh; it now waits for that refresh only if SAM already records the private menu as played. Unplayed choices remain unretained. No deadline, worker limit or assertion was weakened.

Evidence before the final regression run:

- `4590eee3-1791944144756.log`: legacy host context needed the new private port to remain optional when resends are absent. Configured resends still require that port.
- `4590eee3-1791944396075.log`: the new compiled entrypoint and synthetic permission stub needed their declared signatures corrected. `4590eee3-1791944556092.log` was deliberately stopped with signal15 because the entrypoint edit had not applied; it is a killed run, not a test verdict.
- `4590eee3-1791944612623.log`: typecheck/build and seven language/native tests passed; all four signed cases failed because the new entrypoint was not yet listed in the explicit compiled build. The build list and synthetic public catalogue relationships were added.
- `4590eee3-1791944859576.log`: signed admission succeeded, but workflow creation failed before verification. Explicit call-owned composition corrected the stale extra fixture fields.
- `4590eee3-1791945001651.log`: native workflow tests passed, but the four compiled cases exposed the post-play choice timing gap. `4590eee3-1791945245781.log` then caught TypeScript's narrowed private stage; the post-await guard uses the actual aborted lifetime.
- `4590eee3-1791945315945.log`: fresh compiled build and all four signed compiled cases passed, zero failures/skips, terminal exit0, with `npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/voice/confirmation-resend-runner.test.ts'`. Actual signed ingress, real migrated PostgreSQL and synthetic TLS SMTP qualify acceptance, refusal, permission loss and lost acknowledgement without replay; private media, alternate early selection, exact second native appointment and code/contact/chart canaries are checked.

- `4590eee3-1791945545621.log`: typecheck/build and49 of50 checks passed. The new stop fixture stopped at the menu but waited for a recipient-selection result that had not begun; its stop branch was moved to the intended recipient-readback stage. Existing deadlines/workers/assertions stayed intact.
- Final qualification passed typecheck, a fresh compiled build, diff check and50 checks with zero failures/skips: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/voice/confirmation-resend-runner.test.ts test/voice/patient-correction-runner.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/standalone-clinical-host.test.ts test/voice/notification-outcome-query.test.ts test/cliniko/confirmation-resend-language.test.ts test/cliniko/confirmation-resend-workflow.test.ts test/cliniko/confirmation-resend-sam.test.ts test/cliniko/confirmation-resend-session.test.ts test/cliniko/caller-verification-session.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`, tracked job `Abby resend corrected private stop final source build and regression`, log `4590eee3-1791945881887.log`, terminal exit0. This includes all six signed compiled resend cases, the actual explicit language boundary, prior native/SAM/proof cases, existing signed clinical-model and private correction workflows, notification status/privacy, clinical host admission/binding and manifest/trace contracts.

Manifest1.183 adds E2E-375 for synthetic signed voice evidence. Real carrier/model/acoustic/clinic/mailbox acceptance is not claimed. Paging beyond three choices, resend-specific process-loss/operator recovery, journal history portability and clinic-specific virtual/cancelled content remain open, alongside gap6 recurrence/historical sources, remaining field/operator acceptance and gaps9–13. The complete13 objective remains active.

## Gap8 private resend appointment paging

The private appointment owner now retains the complete bounded chronological native list and presents three choices per page. Keypad4 moves forward and keypad5 moves backward only when the played page offers that direction. Returned progress contains count/next/previous flags only. Native appointment identity, intervals, the full list, recipient and code remain private. Paging compares the freshly sorted native list with the original list; response ordering alone is harmless, while insertion, removal, retiming, source/proof/context drift and failed playback withdraw the old choices. Boundary navigation and absent ordinals preserve the current valid page.

Re-entering a private menu now clears an earlier prepared resend in both the native session and SAM adapter, as well as the call-flow reference. This cannot reset an attempted/dispatched send. The existing separately played public confirmation, independent source/permission checks, durable single-attempt journal and receipt-only reconciliation remain in force.

First qualification passed typecheck, a fresh compiled build and eight native/signed checks with zero failures/skips: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-workflow.test.ts test/voice/confirmation-resend-paging-runner.test.ts'`, tracked job `Abby private resend paging first source and compiled qualification`, log `4590eee3-1791946724436.log`, terminal exit0. New native cases cover forward/backward traversal, provider-order independence, exact seventh appointment, boundaries/ordinals, insertion/removal/retiming/failed playback and withdrawal of a prior prepared reference. Signed compiled cases navigate backward and forward, ignore unplayed navigation, select appointment87 under fresh native evidence and separate SAM consent, and deny changed lists without journal submission or native writes. Private media and code/contact/chart canaries are checked.

Final qualification passed typecheck, fresh compiled build, diff check and64 checks with zero failures/skips: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-workflow.test.ts test/voice/confirmation-resend-paging-runner.test.ts test/voice/confirmation-resend-runner.test.ts test/voice/patient-correction-runner.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/notification-outcome-query.test.ts test/cliniko/confirmation-resend-sam.test.ts test/cliniko/confirmation-resend-session.test.ts test/cliniko/confirmation-resend-policy.test.ts test/storage/postgres-confirmation-resend-journal.test.ts test/cliniko/caller-verification-session.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`, tracked job `Abby private resend paging final source build and regression`, log `4590eee3-1791946967608.log`, terminal exit0. All new paging cases, existing signed resend/correction/clinical-model and notification/privacy workflows, native/SAM/source/proof, PostgreSQL durable submission/freeze/rollback and registry/trace checks passed. No failures were bypassed and worker/deadline settings stayed intact.

Manifest1.184 adds E2E-376 as synthetic voice evidence. Process-loss/operator recovery, journal history portability and clinic-specific virtual/cancelled confirmation content remain open. Actual clinic/sender/recipient/model/acoustic/current-head cloud acceptance remains separate, with carrier deferred. Gap6 recurrence/historical sources, remaining field/operator acceptance and gaps9–13 remain in the full13 objective; completion is not claimed.

## Gap8 cold resend receipt recovery and killed-sender evidence

A new privileged recovery reader correlates an exact native confirmation-resend review with its durable journal under independently provisioned current staff inspection permission. Each observation checks current owner approval, administrator membership/session, full scope/business/account/timezone, native request reference and historical owner binding. The native review is read twice and must remain unchanged. It returns fixed status/message and the native acknowledgement flag only; patient, appointment, recipient/content and caller proof remain private. The service has no send, native mutation or journal-completion port.

Receipt states are deliberately distinct. A matching stored acceptance proves mail-service acceptance and does not prove inbox delivery. A pending/unknown record remains unknown even when the recall is checked off. Missing metadata is reported as not recorded and does not prove a live sender has stopped. A mismatched accepted message ID also remains unknown. The restarted private submitter now applies that same correlation check before reporting an existing accepted result.

The authenticated dashboard exposes `POST /api/confirmation-resends/receipt` only through an actual host-provisioned recovery instance. It accepts exactly request/recall references, checks origin and current authenticated clinic-admin identity, and is hidden from the setup-only surface. Request-supplied identity/permission or a generic agent gateway cannot grant this capability. This is an optional staff host seam; default listeners do not activate it from an environment flag.

The native process test drives actual played/affirmed SAM, native reviewed send, real PostgreSQL and synthetic TLS SMTP, then SIGKILLs the sender before claim, after claim, during message submission, after SMTP acceptance before durable finish, and after finish. Cold observations distinguish absent/uncertain/accepted storage accurately. Reconstructed scoped submitters with already claimed references issue no SMTP commands, and native recall acknowledgement changes no receipt classification. Live database, disposable backup and output canary scans cover the synthetic recipient, patient identifier, address/name and chart markers. Temporary files and databases created by the test are removed.

Qualification to date:

- `4590eee3-1791948150559.log`: static failures identified a widened result kind, nullable stdio types and callback-owned native-row narrowing. No runtime evidence claimed.
- `4590eee3-1791948353756.log`: corrected typecheck, compiled voice/dashboard builds and eight recovery/process/neighboring-correction checks passed without skips, including all five actual SIGKILL points.
- `4590eee3-1791948669339.log`: the new correlation witness failed as intended: a restarted submitter reported acceptance for a different message UUID. The submitter now reports unknown for that mismatch without finishing or retrying it.
- `4590eee3-1791948750972.log`: static checks caught two synthetic messages using `address` rather than the established `locationAddress` field. Fixtures corrected; production DTO/template stayed unchanged.
- `4590eee3-1791948886615.log`: typecheck, fresh compiled builds and17 native/HTTP/process/storage/correction checks passed, zero failures/skips, terminal exit0, with `npm run typecheck && npm run build:voice-tests && npm run build:dashboard && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-recovery.test.ts test/cliniko/confirmation-resend-process.test.ts test/storage/postgres-confirmation-resend-journal.test.ts test/cliniko/patient-correction-recovery.test.ts'`. Restart attempts are tested through a real new submitter and concrete TLS adapter after each claimed checkpoint, rather than through claim observation alone.

Final qualification passed typecheck, fresh compiled voice/dashboard builds, diff check and45 checks with zero failures/skips: `npm run typecheck && npm run build:voice-tests && npm run build:dashboard && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-recovery.test.ts test/cliniko/confirmation-resend-process.test.ts test/storage/postgres-confirmation-resend-journal.test.ts test/cliniko/patient-correction-recovery.test.ts test/voice/confirmation-resend-runner.test.ts test/voice/confirmation-resend-paging-runner.test.ts test/cliniko/confirmation-resend-sam.test.ts test/cliniko/confirmation-resend-workflow.test.ts test/cliniko/confirmation-resend-session.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`, tracked job `Abby resend recovery final source build killed sender and voice regression`, log `4590eee3-1791949198203.log`, terminal exit0. New privileged HTTP/receipt/correlation cases and actual five-point SIGKILL/restarted-send evidence passed alongside native/SAM, persistent journal/freeze/rollback, existing correction recovery and signed resend/paging/registry/privacy regressions.

Manifest1.185 adds E2E-377 as native/process/HTTP evidence. Actual deployment of the clinic-owned authenticated session/inspection authority and operator acceptance remain open; this checkpoint does not prove production recovery adoption. Journal history portability and clinic-specific virtual/cancelled content remain unfinished. Gap6 recurrence/historical sources, remaining field/operator acceptance and gaps9–13 remain in the complete13 objective; real clinic/sender/recipient/model/acoustic/cloud qualification is separate and carrier remains deferred.

## Gap8 confirmation resend submission history portability

The previous configuration exporter omitted `confirmation_resend_journal`, target occupancy did not see journal-only tenants, and final target reconciliation ignored those rows. Configuration archives now carry an exact non-patient submission record in the existing `staffWork` section: original request UUID, owner-binding hash, status, message UUID and creation/completion instants, with explicit source clinic/location mapping. Unknown and pending outcomes remain conservative; a contradictory accepted message UUID is preserved and remains unknown when inspected/submitted. Recipient, appointment, patient, caller proof/code, call/session and message content are excluded.

The repeatable-read source snapshot includes every journal location and rejects omitted journal-only scopes. Decoding checks exact fields, UUID/binding/timestamp/status consistency, source scope, stable record identity and tenant-wide uniqueness. Empty legacy sections remain compatible. Reference imports retain the submission history and report the section count accurately; they have no SMTP delivery authority. Native imports insert the same barriers under the reviewed target scope inside the configuration/receipt transaction. Existing target journal rows make the target occupied. Repeated imports reconcile retained barriers and fail if history changed, without repairing or overwriting it.

Final target readiness reconciles the whole tenant journal, including unlisted target locations. Source and frozen-final comparisons already compare the `staffWork` digest and now include these records. Imported UUIDs remain claimed under the old binding, a new binding cannot reuse them, and the restarted private submitter issues no SMTP for every imported outcome. Importing a pending record does not prove a live sender has stopped, and reference history retention does not provision production receipt inspection.

Qualification evidence:

- `4590eee3-1791950440400.log`: the initial static check caught a single-location receipt type that declared the staff-work count as literal zero. Both single/tenant reports and that type now retain actual section counts.
- `4590eee3-1791950605167.log`: typecheck passed;13 of14 focused checks passed. The failing target-readiness fixture exported `unsafeReference` but used the default minimal importer; it now selects the corresponding importer mode.
- `4590eee3-1791950744909.log`: typecheck,16 focused checks and diff check passed, zero failures/skips. Native mapped imports, all persisted outcomes/no replay, malformed/private/duplicate/foreign rows, occupied/incomplete scopes, source/frozen drift, target tampering and forced-insertion rollback were covered.
- `4590eee3-1791950864305.log`: typecheck and fresh compiled voice/dashboard builds passed;58 of59 regression checks passed. The historical correction rollback test upgraded to the latest migration, so migration047's frozen-tenant rejection masked migration046's exact rejection. That fixture now pins its upgrade to migration046, keeping every original correction-history/freeze/truncate/downgrade assertion. No migration guard, runtime deadline or worker setting was changed.
- `4590eee3-1791951097191.log`: all16 correction/resend portability checks passed after the migration fixture correction, zero failures/skips, terminal exit0.

- `4590eee3-1791951131219.log`:58 of59 corrected regression checks passed; the migration assertion passed, but the signed last-page resend case timed out awaiting private selection speech. The original failure did not retain enough fixed phase observations to identify its cause. No production fix is claimed for that timeout.
- `4590eee3-1791951385492.log`: all eight focused signed resend/paging cases passed after adding failure-only diagnostics containing fixed menu/page/choice success flags. No speech, provider identifiers, recipient or verification material enters those diagnostics. Deadlines and concurrency remain unchanged; this passing observation does not establish the original timing cause.

Final regression with those diagnostics passed all59 checks, zero failures/skips, terminal exit0, as `Abby resend portability qualification with private phase diagnostics`, log `4590eee3-1791951480277.log`. Manifest1.186 registers E2E-378 as native/archive/cutover evidence; it does not claim full-call or real-clinic acceptance.

Mapped staff inspection of native reviews still needs validated import provenance, and clinic-specific virtual/cancelled confirmation content remains unfinished. Real clinic-owned session/inspection-authority provisioning, live-sender investigation and operator acceptance remain open. Gap6 recurrence/historical sources, remaining field/operator acceptance and gaps9–13 remain in the complete13 objective. Real sender/recipient/model/acoustic/current-head cloud qualification is separate; carrier remains deferred and completion is not claimed.

Final runtime regression command (fresh disposable PostgreSQL; existing concurrency/deadlines):

```sh
bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/storage/postgres-confirmation-resend-carryover.test.ts test/storage/postgres-confirmation-resend-journal.test.ts test/storage/postgres-config-archive.test.ts test/storage/postgres-minimal-config-archive.test.ts test/storage/postgres-fenced-final-archive.test.ts test/storage/postgres-number-cutover.test.ts test/storage/postgres-cutover-receipt.test.ts test/storage/postgres-patient-correction-carryover.test.ts test/cliniko/confirmation-resend-recovery.test.ts test/cliniko/confirmation-resend-process.test.ts test/voice/confirmation-resend-runner.test.ts test/voice/confirmation-resend-paging-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check
```

Typecheck and fresh compiled voice/dashboard builds passed in `4590eee3-1791950864305.log`; runtime source remained unchanged while the two test diagnostics/fixture corrections were applied. The final publication gate repeats `npm run typecheck && git diff --check` before committing. This checkpoint introduces no dependency, migration or generated schema change. The prior signed paging timeout remains unexplained; passing focused/final runs are evidence of those runs, not proof that the earlier timing risk was corrected.

## Gap8 receipt inspection after mapped configuration transfers

Recovery previously required the native review's logical scope to equal the current target scope. Imported journals retained request UUIDs and old owner bindings, but a later export lost the original scope needed to read that review. Archives now support an exact optional `originScope` containing public tenant/clinic/location identifiers. Legacy records retain their immediate source scope. New target resend activity has no imported origin and keeps its own scope.

The source exporter reads the actual retained import receipt in its repeatable-read snapshot. It checks receipt identity, exact location mappings, tenant-wide UUID uniqueness and the canonical staff-work record count/byte count/digest before preserving original scopes. Every known imported barrier must still exist with the same target location, owner binding and creation instant. Edited or missing history refuses export instead of inventing a new origin or dropping a barrier. Native journal rows remain unchanged; original scopes live in the audited import history. No migration, dependency or generated schema change is introduced.

A concrete target-bound `PostgresConfirmationResendImportHistory` resolves an opaque request UUID from that durable history and its current immutable journal identity. The recovery service accepts it only through trusted host composition, with an actual native reader factory. Factory scope/account must match the resolved origin and current configured Cliniko credential. Native business, timezone, full original location and old owner binding must still agree. Current owner approval, authenticated clinic administrator, current membership and independent native-review inspection permission remain required; the native review is read twice and import identity is re-read before returning. The body remains exactly request/recall references and cannot supply an origin, binding, actor or permission.

The existing authenticated staff HTTP endpoint observes receipts after one, two and three reviewed transfers. Output remains fixed status/message/acknowledgement only. Pending/unknown and contradictory message UUIDs stay unknown; no acceptance implies inbox delivery. Recovery has no SMTP, native mutation or journal-completion port. Imported records do not grant patient permission or reconstruct caller confirmation.

Qualification:

- `4590eee3-1791952294227.log`: runtime typecheck and diff check passed.
- `4590eee3-1791952518107.log`: typecheck plus17 mapped-recovery/original-recovery/archive checks passed, zero failures/skips, terminal exit0.
- `4590eee3-1791952689023.log`: typecheck, fresh compiled voice/dashboard builds, diff check and30 checks passed, zero failures/skips. Positive mapped staff HTTP and new target activity were added alongside source/digest/barrier/permission denial, no mutation/send and journal/frozen/cutover coverage.
- `4590eee3-1791952929775.log`: final typecheck, diff check and58 checks passed, zero failures/skips, terminal exit0. Exact command: `npm run typecheck && bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend-import-recovery.test.ts test/cliniko/confirmation-resend-recovery.test.ts test/cliniko/confirmation-resend-process.test.ts test/storage/postgres-confirmation-resend-carryover.test.ts test/storage/postgres-confirmation-resend-journal.test.ts test/storage/postgres-config-archive.test.ts test/storage/postgres-minimal-config-archive.test.ts test/storage/postgres-fenced-final-archive.test.ts test/storage/postgres-number-cutover.test.ts test/storage/postgres-cutover-receipt.test.ts test/voice/confirmation-resend-runner.test.ts test/voice/confirmation-resend-paging-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts' && git diff --check`. This includes the five real SIGKILL sender checkpoints, signed resend/paging, exact archive import/cutover, legacy compatibility and manifest/trace regressions. No runtime source changed after the fresh builds.

Manifest1.187 registers E2E-379 as native/storage/authenticated HTTP evidence. Native reviews remain private and unmodified. Historical transfers that already discarded original-scope evidence cannot have that evidence inferred from caller input; lookup must fail when the native review cannot match validated retained provenance. Real deployment of the clinic-owned reader factory, authenticated staff session/inspection authority and operator acceptance remain open. The earlier signed paging timeout remains unexplained; this final run passed with the existing diagnostics and unchanged deadlines/concurrency.

Next gap8 work is clinic-specific virtual/cancelled confirmation content and remaining required-field/operator acceptance. Gap6 recurrence/historical sources and gaps9–13 remain in the complete13 objective. Actual clinic/sender/recipient/model/acoustic/cloud qualification is separate; carrier remains deferred and completion is not claimed.


## Gap8 versioned telehealth and cancelled confirmation content

The original email template assumes a physical appointment. New explicit owner approvals select `appointmentDetails.v2` and a unique nonempty subset of `activeInPerson`, `activeTelehealth`, and `cancelled`; captured source changes revoke the approval. Legacy approval and SMTP defaults retain v1. A mismatched adapter cannot construct a resend owner.

Native evidence checks `AppointmentType.telehealth_enabled`. A populated individual appointment link is not evidence of telehealth and is never emailed: Cliniko documents it as a practitioner/admin link. A telehealth message requires exactly one complete, current attendee bound to this booking and verified patient, with an HTTPS Cliniko patient `/c/` link. The appointment, type, attendee and recipient are rechecked through the existing played readback and separately confirmed SAM/send fences. Wrong, duplicate, cancelled, archived, deleted, incomplete or changed attendee evidence denies the send. See [Cliniko's official telehealth guide](https://docs.api.cliniko.com/guides/telehealth_links) and [attendee API](https://docs.api.cliniko.com/openapi/attendee/attendee).

Cancelled messages state that the appointment is no longer booked, include the original date/time and native cancellation instant, and contain neither a physical attendance address nor a join link or refund assertion. Explicitly approved private menus search cancelled appointment dates within the preceding and following 90 days through complete bounded native lists. The lookback follows the current clock during a renewed call; unchanged selected records retain their original interval/status binding. Ordinary appointment reads retain their upcoming active semantics. Restored/changed cancellation evidence withdraws selection or sending. Each request remains a separately confirmed, reviewed, single journaled SMTP attempt. Native review v2 carries only the content-kind label alongside its existing approved context; recipient, link and message content remain private.

Qualification to this point:

- `4590eee3-1791954381828.log`: typecheck/build passed;54 checks ran,51 passed and3 new positive cases failed only the test's incorrect native-patient-ID privacy assertion. Native Cliniko review intentionally requires that binding; its exclusion remains asserted for public state, database and model turns. The test now separately asserts that approved native binding and excludes recipient, link, content and code from native notes.
- `4590eee3-1791954703831.log`: corrected typecheck/fresh compiled build and16 focused native/SAM/SMTP/appointment/signed voice checks passed, zero failures/skips. Includes same-clinic patient-link binding and exact v2 native review validation.
- `4590eee3-1791955025887.log`: a new forty-second renewed-call cancellation selection regression reproduced the old anchor exceeding the history range,1 failure. `4590eee3-1791955062168.log`: the same isolated test passed after the history lower bound was anchored to the current clock,1 pass with no range/timeout/concurrency relaxation.

Final regression passed in `4590eee3-1791955136314.log`: whole-source typecheck, fresh compiled voice build,116 checks, zero failures/skips, terminal exit0 and diff check. It includes native/SAM/private menu/SMTP, both new signed content journeys, existing signed resend/paging, five real SIGKILL checkpoints, cold/mapped staff recovery, archive transfer and ordinary read/review compatibility. Runtime source remained unchanged during this gate.

Exact final command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/confirmation-resend*.test.ts test/cliniko/smtp-appointment-confirmation-delivery.test.ts test/cliniko/appointments.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/review-discovery.test.ts test/cliniko/reviewed-send.test.ts test/storage/postgres-confirmation-resend*.test.ts test/storage/postgres-config-archive.test.ts test/voice/confirmation-resend*.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```

Manifest1.188 registers E2E-380 as synthetic/native evidence only. No full-call evidence is claimed. Real clinic approval/configuration, actual sender/recipient acceptance and operator provisioning remain open. Gap6 recurrence/historical sources and gaps9–13 remain in the complete13 objective.

This checkpoint adds no dependency, migration or generated schema changes. The earlier signed paging timeout remains unexplained; this116-check run passed with retained phase diagnostics and unchanged deadlines/concurrency. Remaining gap8 field/operator/real-host acceptance, gap6 recurrence/historical sources and gaps9–13 remain open.

Publication staged-diff validation initially found a new helper with an extra blank line at EOF (`4590eee3-1791955521254.log`). Removing that blank line changes no test behavior; staged diff validation is repeated before committing.


## Gap9 same-caller task sequencing checkpoint

The supplied call logs' registration fields are covered by the core and required postal adapters. No additional concrete field or clinic approval has been supplied; unspecified clinic-specific adapters and real clinic/operator acceptance remain open. Independent implementation proceeds under the delivery rules.

A private `ClinikoCallTasks` module owns the exact clinic sequence approval, immutable completed-action snapshots, task count and native patient pin. Approval binds scope, account, business, timezone, policy and current clinic administrator; it selects allowed operations,2–10 tasks, fresh verification each task and denial after unresolved actions. The initial admitted caller must remain the same native patient across lookups. The phone match remains a clue; every new owner still creates operation-bound channel verification and checks independent clinic permission. No household, proxy or minor authority is inferred.

After a settled action and played outcome, explicit continuation creates a fresh workflow owner and disposes the old verifier/selection. Completed actions are retained in the authoritative SAM record and cannot be written again. Only an exact retained mutation can return its original fixed receipt. Core next-task events reject uncertain/pending writes; public current-task outcome wording excludes prior-task action keys and cannot describe the first success as completion of an unconfirmed second task. Source/member/candidate/permission drift and exhausted task count deny continuation. Defaults without an approved sequence preserve the existing single-task behavior.

Qualification so far:

- `4590eee3-1791956254008.log`: initial typecheck found missing fingerprint import, clinic-vs-location lookup typing and an omitted public context field.
- `4590eee3-1791956534777.log`: next typecheck found a synthetic callback inferred as Promise<undefined>; its intended Promise<void> interface was corrected.
- `4590eee3-1791956747502.log`: typecheck passed;10 tests ran,9 passed. The new two-task fixture attempted a second selection before acknowledging an intentionally failed-read notice, so confirmation remained unavailable. The fixture now proves no second write, plays the notice and then makes the fresh selection. No production confirmation gate was relaxed.
- `4590eee3-1791957014414.log`:11 corrected native/ordinary-routing/request-safety cases passed, zero failures/skips.
- `4590eee3-1791957148983.log`: whole-source typecheck, fresh compiled voice build and26 native/signed/legacy runner cases passed, zero failures/skips. Both success and unknown-second signed journeys completed. The verification fixture now awaits a fresh result rather than allowing the previous successful result to satisfy the second challenge.

The next gate adds explicit old-proof/offer denial and affected core, catalogue, correction, resend and storage regressions. Native/synthetic evidence is recorded as E2E-381/manifest1.189; no full-call or actual clinic acceptance is claimed. Per-person private selection, independently authorized proxy/minor handling, cross-operation/catalogue task sequences, interrupted publication/recovery and per-task staff outcomes remain in gap9. Gap6 recurrence/historical sources, remaining gap8 adapters/operator acceptance and gaps10–13 stay in the complete13 objective.

Final gate `4590eee3-1791957574193.log` passed typecheck/build and81 of82 cases; the existing E2E-375 permission scenario timed out before a private choice result was observed. Its fixed diagnostics showed a successful menu only, which does not establish whether readiness, input or native preparation was responsible. No timeout/concurrency change or production correction is claimed for that failure.

A subsequent source review found that task selection could install the new owner before its SAM workflow event committed. Preparation and activation are now separate: the new verifier starts only after the exact processed task event and retained predecessor keys are observed. Aborted construction disposes the prepared owner without consuming a task or sending a code; failed activation after the event reserves its task slot, keeps the prior receipt and requires a fresh explicit request. Current-task state excludes the predecessor throughout recovery, while unknown clinical writes still cannot advance.

`4590eee3-1791958168979.log` passed whole-source typecheck, fresh compiled build and20 checks with zero failures/skips, including both activation faults, both signed two-task journeys and all six existing signed resend cases. This is observation of those passing runs, not proof of the earlier timeout's cause. Final full regression follows with the activation changes and preserved ordinary unavailable-workflow fallback.

Final activation regression passed as `Abby final task sequence activation regression`, log `4590eee3-1791958480268.log`, terminal exit0: whole-source typecheck, fresh compiled voice build,84 checks, zero failures/skips and diff check. Includes six new native task cases, both signed two-task journeys, existing single-task routing/intake, service/TLS integration, current resend/paging/content, identity denial, core booking/correction/uncertainty/effect recovery and standalone/portable storage. Source was frozen for that run. The earlier resend private-choice timeout remains unexplained; this pass is current evidence only.

Exact final command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/call-task-sequence.test.ts test/cliniko/cliniko-call-flow.test.ts test/cliniko/request-boundary.test.ts test/cliniko/confirmation-resend-workflow.test.ts test/cliniko/confirmation-resend-content.test.ts test/text/booking.test.ts test/text/correction.test.ts test/text/uncertain.test.ts test/text/caller-identity-denial.test.ts test/text/effect-recovery.test.ts test/storage/standalone-call-state.test.ts test/storage/standalone-ledger-read-gate.test.ts test/storage/postgres-portable-text-calls.test.ts test/voice/call-task-sequence-runner.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/integrated-clinical-runner.test.ts test/voice/confirmation-resend-content-runner.test.ts test/voice/confirmation-resend-runner.test.ts test/voice/confirmation-resend-paging-runner.test.ts test/voice/caller-identity-denial.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```

This checkpoint adds no dependency, migration or generated schema change. Task-history metadata contains action keys only; standalone call, subject pin and owner state remain transient and are not recoverable after process loss. Another-person/proxy/minor authority, cross-operation/catalogue sequence qualification and per-task staff outcomes remain open. Real clinic/source/permission/operator/model/acoustic/cloud acceptance is absent; full-call evidence stays planned. The complete13 goal remains active.

## Gap9 related-person identity and independent authority checkpoint

`ClinikoRepresentativeSelection` composes the actual admitted self verifier,
complete bounded native relationships, private exact first/last name and birth
date, and a separately supplied clinic permission source. The native relationship
is an identity candidate, never permission. An explicit owner file binds account,
business, zone, policy, adult-age threshold, permitted adult/guardian process and
operations. Stable independent authority is checked before a subject read and
again after fresh native evidence. Source/member, actor proof, relationship,
subject identity/registered email and permission drift stop access. The selected
subject obtains a separate actual caller-verification session and fresh OTP at
its native registered email; that proof reaches the existing protected appointment
reader. Stale person references and delegation through a representative proof
are refused. No native write or public patient fields are introduced.

This implements an authority foundation within gap9. It does not activate
ordinary representative speech or workflow routing, authorize new-patient proxy
intake, infer guardian consent from a family label, or provision a real permission
host. Representatives without an independently verified native self record and
children needing a different approved delivery channel still need implementation.
Per-person writes, multiple-person sequencing, cross-operation/catalogue tasks,
staff outcomes and the remaining thirteen-gap requirements remain open.

Initial source check passed. The first fixture run failed at a missing object
brace; the second stopped on strict optional fetch/clock typing. Corrected
whole-source typechecking and28 native/legacy checks passed with zero skips in
`4590eee3-1791960693530.log`. A new actual shared200-per-minute Cliniko budget
witness then failed at the protected read: unnecessary native re-reads in method
policy and candidate lookup consumed the budget. Those two non-disclosing gates
now recheck current process/actor/authority; registered contact and protected
operation permission still independently recheck exact fresh native relationship
and subject evidence. The corrected10-case selection suite passed, including
actual shared-budget actor+subject proof and protected read, in
`4590eee3-1791960898112.log`. No budget, deadline, assertion or concurrency was
increased. Final type/build/serving regression is pending; manifest1.190/382 IDs
keeps native evidence separate from planned voice/full-call qualification.

The first final source/build/serving regression passed60 checks with zero skips
in `4590eee3-1791961018424.log`. A separate actual SAM identity-disagreement
witness then exposed a verifier boundary: the recorded denial did not itself
revoke a verifier outside call-flow disposal. `CallerVerificationSession` now
checks the recorded denial on every active-call check. New representative cases
prove both pre-selection denial and revocation of an already issued delegated
proof, without further related-person reads. The focused22-case representative,
caller-verifier and native identity-denial regression passed without skips in
`4590eee3-1791961423952.log`. Final requalification of the corrected source is
running as `Abby representative final identity fenced source and serving
qualification`, log `4590eee3-1791961473956.log`.

Final corrected-source qualification completed exit0: whole-source typecheck,
fresh compiled voice build, isolated PostgreSQL migrations and61 native/core/
signed-serving checks passed, zero failures/skips, followed by `git diff --check`.
Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791961473956.log`.
Exact command: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/representative-selection.test.ts test/cliniko/email-patient-authority.test.ts test/cliniko/caller-verification-session.test.ts test/cliniko/call-task-sequence.test.ts test/cliniko/cliniko-call-flow.test.ts test/cliniko/request-boundary.test.ts test/voice/call-task-sequence-runner.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check`.
Source was frozen during qualification. Eleven E2E-382 native tests qualify
identity/authority/channel/read boundaries; their registry evidence remains text/
native only, with synthetic voice and full-call planned. No dependency, database
migration or production activation is introduced. Current-head authoritative
cloud qualification and all real clinic/mail/operator/acoustic/carrier gates
remain separate; the complete13 goal stays active.

## Gap9 representative native workflow composition, E2E-383

The actual booking, cancellation, rescheduling and enquiry constructors now
accept a concrete private person selection bound to the exact operation, call,
session, inbound caller, account, business and zone. Representative method
approval, current workflow policy and independent clinical operation permission
are added to the selector’s own authority checks. Neither parent proof nor
family linkage alone can supply subject authority. Fresh selected-channel codes
feed the existing source, SAM consent, review, one-send and inspected outcome
protocols. A timed-out constructor disposes a delegated verifier that finishes
later. Ordinary person voice routing and multiple-person task composition remain
unfinished; unsupported workflows do not inherit representative configuration.

A real shared-budget witness exposed duplicate native identity checks: the move
exhausted200 requests before PATCH, with no overlapping actor checks and no
signal abort. Native outer/inner guard validation and destination/menu routing
were repeating the same proof checks. Metadata-only checks now apply only at
non-disclosing routing or inside exact concrete native source validation. Native
sources still validate identity before and after protected provider reads. The
public destination read is bracketed by fresh protected target checks, using
exact one-use evidence owned by that source; copied, foreign or consumed
evidence is rejected. Contact and permission use native evidence once within
the same bounded verification transaction, with current independent operation
permission still checked separately. No quota, deadline, consent, mutation or
inspection assertion was raised or removed.

The current focused whole-source typecheck and63 native/legacy checks passed
with zero failures/skips in `4590eee3-1791968768873.log`, including guardian
booking, full related-person cancellation/move, unchanged actor appointment,
late construction and evidence ownership. A preceding37-case shared-budget
run passed in `4590eee3-1791968516077.log`. Earlier failures remain evidence,
including the exact allowed200/denied1 move witness in
`4590eee3-1791967143697.log` and the phase profile in
`4590eee3-1791967316822.log`. Final fresh compiled/serving regression and
publication are pending. Manifest1.191 retains383 IDs and marks native/text
evidence separately from planned representative voice/full-call journeys.
The complete13 objective remains active, including the remaining gap6/8 work,
private person speech/actions/task routing within gap9 and gaps10–13.

Final frozen-source qualification completed exit0: whole-source typecheck,
fresh compiled voice build, isolated PostgreSQL migrations and102 checks passed,
zero failures/cancellations/skips, followed by `git diff --check`.
Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791969058497.log`.
Exact command: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/representative-workflow.test.ts test/cliniko/representative-appointment-change.test.ts test/cliniko/native-validation-context.test.ts test/cliniko/representative-selection.test.ts test/cliniko/rescheduling-authority.test.ts test/cliniko/rescheduling-session.test.ts test/cliniko/booking-offers.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/caller-verification-session.test.ts test/cliniko/call-task-sequence.test.ts test/cliniko/cliniko-call-flow.test.ts test/voice/call-task-sequence-runner.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check`.
Representative cases cover native workflow composition; the signed serving
regressions cover the existing routes. They do not prove representative voice
routing or atomic protection against external Cliniko writers. No dependency
or migration was added. Current-head cloud qualification remains a separate
publication gate, and the complete13 objective remains active.

E2E-383 publication completed at `ecae8abd6d043c0caa8ec6f650657bd5043b061d`,
PR457 remains open/draft. Exact-head PR run38541821802 and push run38541812800
completed failure with four jobs each and zero steps. Fresh check annotations
115778166480/115778139535 cite failed account payments/spending limits preventing
startup; the Ubuntu image notice is unrelated. No cloud pass or merge readiness
is claimed. Publication log: `4590eee3-1791969716701.log`.

## Gap9 private selected-person CallFlow routing, E2E-384 (unpublished)

A trusted CallFlow method now takes only the exact private selector and opaque
reference. Account/business/zone/operation/call/session/inbound binding precedes
owner construction. Existing subject verification, private keypad, SAM consent,
native review and inspected booking remain in use. Public operation changes
retain the selected-person context and cannot silently switch to the caller.
Pending task installation retains that context; call close and identity denial
dispose subject selection. The root actor is independently owned.

The first whole-source typecheck and19 native cases passed in
`4590eee3-1791970004679.log`. Review found that a stray representative property
could enter through a spread constructor config. The explicit rejection witness
failed in `4590eee3-1791970394831.log`; the constructor now rejects that property,
and the fixture removes it before calling the private method. The corrected20
native/legacy cases passed without failures/skips in
`4590eee3-1791970446346.log`. Exact corrected command:
`bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/representative-call-flow.test.ts test/cliniko/representative-workflow.test.ts test/cliniko/cliniko-call-flow.test.ts test/cliniko/call-task-sequence.test.ts'`.
Manifest1.192/384 registers native/text evidence only. Current corrected-source
typecheck/build/serving requalification is pending. Ordinary private identity
speech, per-person root lifetime composition, multiple-person task journeys,
other representative CallFlow operations and the remaining13 requirements are
still open. No real mail, Twilio number, dependency or migration is introduced.

The first final E2E-384 run (`4590eee3-1791970580816.log`) passed source
checking and the compiled build, then completed105 cases:95 passed,10 failed,
zero skips. Existing rescheduling/menu/mail/review assertions and signed task/
identity PostgreSQL cleanup cases failed; the three new E2E-384 cases passed.
Observed host pressure during failures was CPU some96%, memory some79%/full40%,
276 MB available and full4095 MB swap. This is a contention witness, not proof
that every failure has that cause. No runtime quota/deadline/assertion changed.
Phase-only diagnostics now annotate the rescheduling fixture's failed readiness
assertions without extra native reads, patient fields, refs or codes. The first
owning case passed all nine revocation variants unchanged in the isolated run
`4590eee3-1791971736612.log`. Memory pressure later cleared (5 GB available,
zero measured memory stalls). Full source/build/105-case qualification is being
repeated with the same four-worker setting as tracked job
`Abby E384 corrected source requalification after pressure cleared`, log
`4590eee3-1791971858998.log`. E2E-384 remains unpublished until that gate passes.

The next full run (`4590eee3-1791971858998.log`) passed source/build and103/105
checks with zero skips. Two preparation failures remained: the related-person
move could not select its target (48 native claims, no quota denial, no failed
actor recheck or provider error), and the private CallFlow booking had no
prepared action. These failures were not declared fixed. Failure-only timing/
boolean diagnostics now observe existing caller proof/channel/ownership,
selected recipient, native target/practitioner and offer methods without extra
reads or altered results. All5 focused representative cases passed in
`4590eee3-1791972810744.log`. The complete same-worker native/signed diagnostic
run then passed105 checks with zero failures/skips in
`4590eee3-1791973158633.log`. Original timing attribution remains unproven.

Review then found an actual process-boundary defect: `ClinikoCallTasks` approves
`patientSelection: sameVerifiedCaller`, but the new delegated constructor could
bypass that sequence's lookup pin. The new rejection witness failed (the route
returned success) in `4590eee3-1791973592977.log`. The current self-only task
protocol now rejects delegated workflow installation; related-person sequences
require their own explicit protocol and remain within the goal. This gate does
not affect the individual representative route or existing self task sequences.
The corrected12-case representative/task regression passed without skips in
`4590eee3-1791973693764.log`. A fresh type/build/106-case final qualification is
pending before publication; all thirteen requirements remain active.

Final corrected-source qualification completed exit0: whole-source typecheck,
fresh compiled voice build, isolated PostgreSQL migration and106 native/signed
checks passed, zero failures/cancellations/skips, then `git diff --check`.
Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791973874880.log`.
Exact command: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/representative-call-flow.test.ts test/cliniko/representative-workflow.test.ts test/cliniko/representative-appointment-change.test.ts test/cliniko/native-validation-context.test.ts test/cliniko/representative-selection.test.ts test/cliniko/rescheduling-authority.test.ts test/cliniko/rescheduling-session.test.ts test/cliniko/booking-offers.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/caller-verification-session.test.ts test/cliniko/call-task-sequence.test.ts test/cliniko/cliniko-call-flow.test.ts test/voice/call-task-sequence-runner.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check`.
No runtime budget, deadline, concurrency, native inspection or assertion was
relaxed. Original preparation timing failures remain unexplained and retained
in the evidence history. The constructor/task approval defects were reproduced
and corrected. Four E2E-384 native cases qualify the private route; existing
signed serving regressions qualify their existing routes, not private identity
speech. The full13 goal remains active, and no real sender, clinic, acoustic
or carrier activation is inferred. No dependency or database migration added.

## Gap9 call-owned actor and private patient identity component, E2E-385 (unpublished)

The new call-owned representative verifier captures independent native self
verification and clinic-approved related-person policy. Its actor remains alive
through exact name/birth-date selection, fresh patient channel proof and native
workflow execution. Full scope/call/session/account/business/zone/inbound and
shared-budget identity must match the actual CallFlow. Actor permission and
clinical subject permission stay independent; closure disposes both proofs.
The private input component keeps actor code media and patient code media out
of transcription, collects only first/last name and birth date in separate
private sessions, and permits field reset after played private readback before
lookup/delivery. A failed caller instruction receipt closes without mail.

The first source check passed and11/12 runtime checks passed in
`4590eee3-1791975106850.log`. Native booking was uncertain because the fixture
returned a review receipt for the actor rather than the selected patient. Its
native receipt now identifies the actual requested subject; the unchanged
committed/one-write assertions passed in the corrected32-case run
`4590eee3-1791975362300.log`. A later source check found a readonly working draft
and a missing moved test import (`4590eee3-1791975880218.log`), both corrected.
The next source check passed but17/19 cases passed (`4590eee3-1791975991492.log`):
private field collection stopped after actor code. A length/boolean-only code
witness (`4590eee3-1791976203364.log`) proved actor verification succeeded; the
fixture requested20ms silence below the controller's100ms minimum. With legal
endpoint timing and enough synthetic silent frames, all19 native/component
cases passed without skips in `4590eee3-1791976239355.log`. No controller,
verification or API budget/deadline/permission/assertion was relaxed.

Manifest1.193/385 records native/component evidence only. Actual private
representative presentation, request routing and serving composition remain
unfinished, as do explicit multiple-person task approval/caller pin, sequences,
other workflows and remaining full13 requirements. Full source/build/serving
regression is pending before publication. No dependency or migration added;
all audio/identities are patient-free fixtures and no real mail/carrier activated.

Final frozen-source E2E-385 qualification completed exit0: whole-source
checking, fresh compiled voice artifacts, isolated PostgreSQL migration and112
native/component/signed-serving checks passed, zero failures/cancellations/skips,
followed by `git diff --check`.
Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791976378799.log`.
Exact command: `npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/voice/private-representative-input.test.ts test/cliniko/representative-call-owner.test.ts test/cliniko/representative-call-flow.test.ts test/cliniko/representative-workflow.test.ts test/cliniko/representative-appointment-change.test.ts test/cliniko/native-validation-context.test.ts test/cliniko/representative-selection.test.ts test/cliniko/rescheduling-authority.test.ts test/cliniko/rescheduling-session.test.ts test/cliniko/booking-offers.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/caller-verification-session.test.ts test/cliniko/call-task-sequence.test.ts test/cliniko/cliniko-call-flow.test.ts test/voice/call-task-sequence-runner.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check`.
The new media cases use component callbacks and deterministic synthetic PCM;
they do not qualify ordinary representative request routing or the actual
private playback event. Existing signed tests cover their existing routes.
The full13 goal remains active, with private presentation/serving composition,
multiple-person process/caller pin and sequences still required within gap9.
