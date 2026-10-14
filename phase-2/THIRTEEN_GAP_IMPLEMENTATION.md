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
| 8 | Add patient detail corrections, required registration fields and resends. | E2E-361–368 locally qualify patient corrections, account revisions, linked recovery, private edit/reset and guarded setting-history portability. E2E-369 adds independently approved required address fields, complete private collection/readback, field-bound host authority, native response/inspection and separate registration/booking confirmation; final typecheck/build and80 checks passed without skips. Confirmation resends, unsupported clinic-specific field adapters and production recovery-host/operator integration/acceptance remain open; current-head cloud and actual clinic/mail/model/acoustic acceptance are absent. |
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
