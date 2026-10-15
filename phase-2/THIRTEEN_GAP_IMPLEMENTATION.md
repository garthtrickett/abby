# Cliniko integration: thirteen-gap implementation order

Activated by the owner: bridge all thirteen gaps in the agreed order, including every part that can be completed without a Twilio number. The October 10 source comparison is an inventory, not a completion claim. Existing no-number contracts and privacy rules still apply.

## Requirements and evidence needed

| Order | Requirement | Current work and completion evidence |
| --- | --- | --- |
| 1 | Wire existing booking, enquiry, cancellation, rescheduling and intake into the running receptionist. | Local engineering proof now covers all five workflows through separately compiled runner subprocesses, signed serving paths, private verification, played confirmation, current-policy denial, independent permission, delivery loss and no replay. CI and real activation remain open under gaps 2–4. |
| 2 | Connect caller verification and clinic-approved permissions. | Separate draft PR 454 adds real TLS SMTP to the actual verifier/protected read with synthetic data; typecheck and 22 checks passed, including failed delivery and independent permission denial. Real sender/mailbox, accepted clinic policy and deploying-host permission source remain open. Channel possession alone cannot grant proxy/minor authority. |
| 3 | Establish message delivery, staff handoff, monitoring and recovery ownership. | Four compiled-runner staff journeys now pass: named saved request, unknown write without replay, permission denial before mail and revocation before send. Existing recall/review/aggregate contracts remain. Deployed monitoring receiver, real sender and human clinic process remain open. |
| 4 | Complete synthetic speech, public transport and eventual carrier qualification. | Prior synthetic runtime evidence exists; noisy/safety and repeated speech gates remain open. The October14 repeated baseline remains source-matched and fails with11 critical misses in18 runs and41.67% WER. Near-field reduction worsens WER to50.76%; the committed-turn model improves to30.30% but still has10 critical misses. No candidate passes or is promoted. The October15 follow-up independently verifies codec/input bytes and adds16 fixed patient-free booking/date/correction clips with48 repeated recognitions:24/24 quiet matches, but five noisy critical misses. Interpolation and direct-audio model screens also fail; production sources and thresholds remain unchanged. Speech-provider credits were restored in the earlier investigation; public tunnel still requires a dedicated usable route. Twilio-number carrier evidence is deferred, not substituted with synthetic results. |
| 5 | Expand services, duration choices, locations and initial/follow-up rules. | Current service/intake variants, return rules and independently provisioned multi-location compiled hosts are locally qualified in draft457. Actual clinic configuration/acceptance and authoritative CI remain open. |
| 6 | Extend searches and support online-disabled services where required. | E2E-356 locally qualifies complete approved longer online searches and a compiled two-month late-range booking. E2E-357/358 add independently approved non-recurring native calendars, complete adaptive busy reads, Sunday0/7 and compiled returning/first-time location/member coverage with fresh chosen-day reads. E2E-404 additionally supports explicitly approved dated native recurring busy occurrences with actual compiled booking and late-conflict denial. E2E-414 additionally qualifies independently approved dated native recurring opening occurrences with actual compiled booking, legacy denial and late-conflict denial. Undocumented future expansion and broader real-calendar/source acceptance remain unproven; preserve incomplete-source denial, date bounds and offer/commit agreement. |
| 7 | Support another approved practitioner during rescheduling. | E2E-359 locally qualifies explicit approved practitioner pairs, independent destination policy, named played confirmation and one inspected in-place move at a changed or retained time. E2E-360 adds the current approved directory, retained original preference, played name/ordinal choice, pagination, fresh-time invalidation and ordinary signed/compiled dialogue. Final type/build and 99 checks passed; current exact-head cloud, real model/acoustic and clinic acceptance remain open. |
| 8 | Add patient detail corrections, required registration fields and resends. | E2E-361–368 locally qualify patient corrections, account revisions, linked recovery, private edit/reset and guarded setting-history portability. E2E-369 adds independently approved required address fields, complete private collection/readback, field-bound host authority, native response/inspection and separate registration/booking confirmation; final typecheck/build and80 checks passed without skips. E2E-370–379 qualify resend SMTP, native evidence, SAM consent, signed private selection/paging, interruption recovery and mapped staff receipt inspection. E2E-380 now locally qualifies explicit versioned in-person/telehealth/cancelled formats through116 final checks. Unsupported clinic-specific field adapters and production recovery-host/operator integration/acceptance remain open; current-head cloud and actual clinic/mail/model/acoustic acceptance are absent. |
| 9 | Handle multiple patients/actions in one call. | E2E-381–387 qualify same-caller and independently verified two-person booking tasks, fresh private proofs, native writes and immutable receipts. E2E-388 additionally qualifies enquiry-only progression after played protected-read notices, two patients appointments in one signed call with zero mutation, and retired read-receipt integrity. E2E-389 qualifies actual signed related-person cancellation/rescheduling and mixed enquiry/change with fresh proof and preserved original records. Current type/build/isolated PostgreSQL final regression passed195 checks, zero skips. Other patient/operation/catalogue/staff combinations, unrelated representatives without a native self record and alternative guardian channels remain unfinished. |
| 10 | Add class attendance booking, cancellation and movement. | E2E-390 now supplies a protected native class reader: existing sessions, complete active capacity, exact own attendee target and native drift/privacy checks. E2E-391 additionally supplies guarded native single-attendee registration/cancellation and exact inspection; E2E-392 adds locally qualified text class booking through actual verification, played SAM terms/consent, owned review, one inspected attendance write and capacity-race handling. E2E-393 now qualifies actual text cancellation with operation-bound proof, independent class/fee policy, played selection/consent and one owned review/inspected attendee PATCH. E2E-394 additionally qualifies admitted class owners, ordinary class classifier routing and synthetic signed HTTP/WebSocket booking/cancellation with correction and exact native inspection. E2E-395 additionally qualifies sixteen actual compiled class runner journeys through normal host provisioning, shared PostgreSQL budget/contact revision, admission/allowlist, private code, exact native receipt, current-authority denials and capacity races. E2E-396 adds complete multi-service class selection with played public choices, exact instructor/duration binding, current setting checks and actual native/compiled booking/cancellation. E2E-397 adds an explicit native class move/recovery coordinator and provider-owned movement review. E2E-398 adds protected text SAM movement and E2E-399 adds admitted ordinary class movement and signed voice. E2E-400 adds separately compiled native movement under the physical PostgreSQL budget. E2E-401 adds pre-send played-offer/new-date class movement correction and signed preparation evidence. E2E-402 additionally qualifies guarded account-budget waits, complete ordinal corrected same/cross-service signed commitments and a compiled ordinal corrected cross-service move across real quota waits with connected-call lease renewal. E2E-403 additionally qualifies complete signed and compiled date corrections for same and different-service/instructor/duration moves across real quota waits. E2E-405 adds private native case session tracking; E2E-406 connects explicit pass selection to ordinary played booking consent, versioned review, exact native attendee association and whole-case one-consumption inspection, including last-session and concurrent-use handling. E2E-407 additionally connects explicit pass cancellation to approved release/unchanged/consume terms, guarded quota waits, a versioned review and exact final case-effect inspection. E2E-408 adds the documented guarded case-association update, exact native is-null staging reads and whole-case original/replacement inspection; host staging/recovery and caller movement remain incomplete. E2E-409 composes these into a native pass movement/recovery coordinator with explicit independent source/destination and actual-effect authority, full and cross-case/service moves, a bounded complete private review and unchanged physical quota. E2E-410 additionally connects native pass movement to private offers, explicit owner-approved pass effects/recovery, played SAM consent, admitted service routing and separately compiled signed runner journeys under the physical quota. E2E-411 additionally qualifies501 linked records for a same-case/service movement and201 for other case/service/instructor/duration combinations through actual compiled serving, with explicit native state inclusion and exact cancellation-reason proof. E2E-412 additionally qualifies999 same-case/service associations with shared complete snapshots, independent permission for both targets and a private success-cost lower bound that withholds known oversized offers and rechecks before replacement. E2E-415 additionally accounts for observed class attendance and relationship pagination plus replacement page growth at offers, fresh proposal and pre-write, with native exact-cost and compiled preservation/positive evidence. E2E-416 additionally qualifies shared operation allocations, a legacy-worker database guard, process-death expiry and an actual compiled independent competitor with unchanged authority/compensation/history/consent checks. E2E-417 additionally qualifies native case-pass bounded stages across real PostgreSQL quota windows, fresh same-patient proof/consent, current native review ownership and killed-sender discovery. E2E-418 additionally qualifies private same-patient verifier succession, actual renewed-proof/native-stage composition after source expiry and shared PostgreSQL verification-budget/privacy evidence. Staged caller/SAM and operator resolution integration, complete cost admission, broader/mixed catalogue/correction qualification, financial provisioning, membership money and additional operator acceptance remain unfinished. Individual endpoints are insufficient. Require existing session/attendee identities, capacity and duplicate checks, compensating move recovery and truthful concurrent-result handling. Membership credits/passes require their own evidence. |
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


## Gap9 ordinary representative request and signed private serving, E2E-386

An explicit related-person request now selects a workflow without placing names,
birth dates, channel addresses or authority references in the ordinary intent.
Caller identity denial and explicit urgent routing precede this path. A pending
call-owned representative is prepared without email, then activated only after
the exact accepted workflow-start receipt with matching operation, revision and
turn. Self booking is unavailable while the actor awaits patient selection.
Preparation abort closes late construction; abandonment releases the pending owner.

The trusted clinical voice host requires a separate private transcription port
when representative input is enabled. Actual serving waits for the startup
notice's playback and an explicit keypad start. Each caller instruction, private
field prompt, patient readback and patient-code instruction uses the actual
VoiceSession transient-content/playback path. Private SAM notices contain blank
text and audit records retain presentation/session references only. Caller and
patient codes remain keypad-only. Independent actor, representative and clinical
permissions, fresh subject proof, played SAM consent, native review and one-send
inspection are unchanged.

The first new source/test check failed on TypeScript result-union inference and
getter narrowing (`4590eee3-1791978163925.log`); test expressions were corrected.
The next check passed type/build but only5/9 cases passed
(`4590eee3-1791978243215.log`). Startup incorrectly checked the negative request
boundary rather than a workflow receipt. A dedicated receipt containing only
turn/operation/next is now written by the accepted workflow transition; wrong or
unaccepted events still deny activation. A direct inability-to-breathe phrase
also previously reached routine representative routing; this explicit routing
cue now takes the urgent handoff path without a diagnosis or clinical advice.
No verification, permission, send or confirmation gate was weakened.

Corrected source/build and9 focused checks passed, zero failures/skips, in
`4590eee3-1791978404625.log`. Two additional event/key/disconnect cases brought the
focused result to11 passed, zero failures/skips, in
`4590eee3-1791978582504.log`. The signed HTTP/WS synthetic booking reaches one
native selected-patient booking after two separate codes and actual played
private/public prompts. Its isolated database canary scan is empty. An early
start key sends no mail; disconnect during unplayed caller instructions closes
the actor and sends no mail or appointment mutation.

Files affected: core workflow/private-presentation contracts and receipt,
TextReception and VoiceSession; ClinikoCallFlow and representative call owner;
private representative collector and transient/clinical host composition;
public request and urgent routing; PostgreSQL audit projection; shared fixtures,
five representative test files, and the scenario registry/design. No dependency,
database migration, real patient material, real sender or carrier was added.
Manifest1.194/386 records synthetic serving and event/component evidence;
full-call production evidence remains planned.

The first frozen-source type/build/native/serving/core/storage/contract regression
ran140 cases:139 passed, one failed, zero skips, terminal exit1 in
`4590eee3-1791978662937.log`. E2E-319 found that a representative request on an
unconfigured host bypassed the existing proxy boundary, leaving its unsent
self verifier in place rather than requiring fresh proof on a later self
request. Routing readiness now selects the new path only on configured idle
hosts; other requests retain the accepted proxy boundary and its owner cleanup.
Cleanup also disposes pending/current representative owners when no work was
sent. Existing denied/sent receipts remain untouched. Focused source/build and
caller-denial correction is running in `4590eee3-1791978950767.log`; publication
awaits corrected qualification. Other representative operations/catalogue, explicit
multiple-person task approval and stable caller lifetime, unrelated
representatives without a native self record, alternative guardian channel,
staff sequences, gap6 recurrence and gaps10–13 remain in the full objective.
Actual clinic/mailbox/model/acoustic/carrier acceptance and authoritative cloud
qualification remain separate gates. This checkpoint does not complete gap9.


The corrected startup/boundary source check and fresh voice build passed with
all7 targeted event/language/signed/E2E-319 cases, zero failures/skips, terminal
exit0 in `4590eee3-1791978950767.log`. The original E2E-319 assertions and worker
count remain unchanged. The final broader regression now includes both existing
native and text request-boundary suites and runs against this unchanged source
and compiled build as `Abby E386 corrected final native serving storage and
boundary regression`, log `4590eee3-1791979091212.log`. No live gate result is
claimed until its terminal output is observed.


The corrected wider regression finished exit0 with142 passing checks, zero
failures/cancellations/skips and a clean diff check in
`4590eee3-1791979091212.log`. It used the corrected source/build qualified in
`4590eee3-1791978950767.log` and preserved the four-worker setting. Its exact
command is the E2E-385 regression command above plus
`test/cliniko/representative-workflow-start.test.ts`,
`test/voice/representative-request-language.test.ts`,
`test/voice/private-representative-presentation.test.ts`,
`test/voice/representative-workflow-call.test.ts`,
`test/voice/openai-clinical-intent.test.ts`,
`test/voice/urgent-conversation-routing.test.ts`,
`test/voice/standalone-clinical-host.test.ts`, `test/text/booking.test.ts`,
`test/text/correction.test.ts`, `test/text/uncertain.test.ts`,
`test/text/request-boundary.test.ts`, `test/cliniko/request-boundary.test.ts`,
`test/storage/standalone-call-state.test.ts` and
`test/storage/postgres-portable-text-calls.test.ts`. The unchanged compiled
artifacts were used; type/build evidence is the immediately prior source gate.

A final source review reproduced overlap between representative booking words
and an explicit request to speak to reception. Human-request interpretation now
precedes routine representative startup, while identity denial and urgent
handoff retain their earlier priority. Both configured and disabled-host intent
tests assert staff request and no representative owner/email. This final
routing-only correction has a fresh type/build/serving/intent/denial/urgent and
manifest qualification running in `4590eee3-1791979317435.log`; it is not silently
attributed to the prior142-case source result.


Final E2E-386 human-priority qualification finished exit0 in
`4590eee3-1791979317435.log`: whole-source typecheck, fresh voice build and22
checks passed, zero failures/cancellations/skips, plus clean diff check. Source
remained unchanged throughout this final gate. Exact command:

```sh
npm run typecheck && npm run build:voice-tests && node --test --test-concurrency=4 test/cliniko/representative-workflow-start.test.ts test/voice/representative-request-language.test.ts test/voice/representative-workflow-call.test.ts test/voice/private-representative-input.test.ts test/voice/private-representative-presentation.test.ts test/voice/caller-identity-denial.test.ts test/voice/openai-clinical-intent.test.ts test/voice/urgent-conversation-routing.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check
```

The142-case gate precedes the final small human-priority correction; the22-case
gate includes the current correction and its actual signed/denial/intent/urgent
regressions. These are separate evidence scopes, not an invented combined count
or production acceptance. The full13 objective and all remaining requirements
above remain active. PR457 remains draft pending authoritative current-head
cloud qualification and actual activation gates.


## Gap9 explicitly approved multiple-patient tasks, E2E-387 (unpublished)

The existing sameVerifiedCaller approval does not approve another patient.
An independentlyVerifiedPatients mode now separately permits sequencing for
book/cancel/reschedule/appointment-read operations. The task lookup pins the
caller, while representative authority, clinical permission and fresh patient
channel proof remain independent for each task. The demonstrated journey books
two different patients, one adult and one guardian-authorized minor, with four
separate codes, private name/birth-date fields/readbacks and separately played
SAM confirmations. Other operation/catalogue/task combinations remain open.

Preparation sends no code and does not dispose the current actor. Accepted
next-task receipts publish the next root and retire exact prior actions, then
close the previous actor/subject owners. Aborted preparation preserves the prior
owner/receipt and allows a fresh request. Uncertain actions, source/member or
caller-candidate drift, revoked caller permission and the task limit deny
continuation. Legacy same-caller approval still denies representative startup.
Routing checks the current approval before selecting this path; metadata flags
cannot manufacture patient authority. The private input resets only after a
completed owner is closed and the accepted new owner has the same call/session.

Initial source checking passed in `4590eee3-1791979891881.log`. The first native
sequence run passed14/15 cases (`4590eee3-1791980048231.log`): its second booking
was rejected. A count-only witness showed201 claims and one denial
(`4590eee3-1791980223803.log`); phase accounting showed26 calls for first proof,
135 at first commit and161 at second proof (`4590eee3-1791980373323.log`). No
API budget was enlarged or clock advanced to obtain a pass.

A private, one-use concrete booking-guard receipt now brackets the actual
availability read with native authority checks. Inside that bounded read the
offers reader validates current proof ownership rather than repeating the same
native checks. Foreign/forged/reused receipts deny. Private menu-reference
routing grants neither patient access nor permission; the proposal guard still
validates fresh native authority before SAM speech, and write/inspection do so
independently. Native inspection checks immediately before each provider read,
then after the final read, with the second read's fresh check also following the
first. The controller still sends once, inspects the actual result and reports
uncertainty truthfully.

The first bracket correction passed24/25 cases and reduced first commit135 to
111 but remained over quota (`4590eee3-1791980530023.log`). A later run passed47/49
(`4590eee3-1791980814579.log`): the second possible write was uncertain at201
claims, and a new contact-drift test was changing an inactive fixture setter.
The fixture now changes the actual native contact response; its unchanged
rejection assertion passes. Further private-reference routing avoided duplicate
validation before the proposal guard. Current typecheck and57 native booking,
revocation and task checks passed, zero failures/skips, in
`4590eee3-1791981142215.log`, including complete two-patient native bookings
under the unchanged shared200-request budget and four-worker setting.

The first signed-source gate stopped on an optional native-row map value in the
fixture (`4590eee3-1791981325033.log`); an explicit row assertion corrected the
type. Fresh source/build and signed private/native qualification then passed14
checks with2 existing database-dependent compiled task checks skipped in that
invocation (`4590eee3-1791981493182.log`). The new actual signed two-patient test
itself passed, including both private collections, four codes, separate native
subjects/writes, preserved first receipt and an empty isolated database canary
scan. These14 checks are not a claim that the skipped cases ran.

Manifest1.195/387 records native and synthetic serving evidence; production
full-call evidence remains planned. The final source/build and isolated
PostgreSQL native/voice/storage regression runs as `Abby E387 multi patient final
source native voice storage regression`, log `4590eee3-1791981761585.log`. It
includes those previously skipped compiled cases with actual database setup;
publication awaits its terminal result.

Files affected: task approval/sequence, CallFlow startup/retirement and public
routing, private representative collector, booking guard/offers/menu/native
inspection composition; shared fixtures, native task/bracket and signed two-person
tests, registry/design/implementation ledger. No dependency or migration added.
The full13 objective remains active: other patient/operation/catalogue/staff
sequences, unrelated representatives without a native self record, alternative
guardian channels, remaining gap6/8 work and gaps10–13, plus actual clinic,
mailbox, speech, carrier and authoritative cloud acceptance remain unproven.


Final frozen-source E2E-387 qualification finished exit0 in
`4590eee3-1791981761585.log`: whole-source typecheck, fresh compiled voice build,
isolated PostgreSQL migrations and166 native/private/signed/compiled/core/storage
and registry checks passed, zero failures/cancellations/skips, plus clean diff
check. The two previously skipped compiled task cases now ran with real isolated
database setup. Runtime source stayed unchanged throughout this final gate.

Exact command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/representative-task-sequence.test.ts test/cliniko/booking-native-proof-bracket.test.ts test/voice/representative-task-sequence-call.test.ts test/cliniko/representative-workflow-start.test.ts test/cliniko/representative-call-owner.test.ts test/cliniko/representative-call-flow.test.ts test/cliniko/representative-workflow.test.ts test/cliniko/representative-appointment-change.test.ts test/cliniko/representative-selection.test.ts test/cliniko/native-validation-context.test.ts test/cliniko/call-task-sequence.test.ts test/cliniko/cliniko-call-flow.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-session.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-best-effort-edge.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/rescheduling-session.test.ts test/cliniko/rescheduling-authority.test.ts test/voice/representative-workflow-call.test.ts test/voice/private-representative-input.test.ts test/voice/private-representative-presentation.test.ts test/voice/representative-request-language.test.ts test/voice/call-task-sequence-runner.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/voice/openai-clinical-intent.test.ts test/voice/urgent-conversation-routing.test.ts test/voice/standalone-clinical-host.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/text/request-boundary.test.ts test/cliniko/request-boundary.test.ts test/storage/standalone-call-state.test.ts test/storage/postgres-portable-text-calls.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```

This qualifies the demonstrated two-person booking sequence, not every
patient/action/catalogue combination or an actual clinic/carrier deployment.
The remaining full13 scope is retained above. No real patient traffic, email
sender or Twilio number was activated; current authoritative CI remains required
before this draft can be ready or merged.


## Gap9 enquiry-only multiple-patient tasks, E2E-388 (unpublished)

Successful protected enquiries create no clinical action. Previously sequencing
therefore could not advance after a read. A shared core completion predicate now
requires an actual shown/empty read after the current appointment-read workflow
start and its actually played notice. Failed/unplayed/earlier workflow reads
cannot settle that workflow. Core next-task acceptance and the approved task
owner use this same predicate, while clinical action/effect/staff uncertainty
still denies progression. This receipt grants no patient authority.

Task retirement now captures prior read receipt and played presentation as well
as prior clinical actions. Changed old receipts deny later progression. Every
new patient still requires fresh caller and patient proof plus independent
representative and read permission. Old appointment choices cannot select the
new patient. The notice-ID function was moved unchanged to a small core module,
with the original transition export retained, to avoid a completion/transition
import cycle; IDs and existing callers remain unchanged.

The native fixture adds independently approved read permissions and native
patient-bound appointment rows alongside its existing book path. It still owns
one shared200-request budget and synthetic mail only. Production source has no
new dependency or migration and activates no email sender or Twilio number.

Initial source checking passed in `4590eee3-1791982653359.log`. Native enquiry and
existing sequencing tests passed16 cases, zero failures/skips, in
`4590eee3-1791982855659.log`. Actual signed serving plus existing appointment
read, private two-person booking and compiled sequencing regressions passed23
checks, zero failures/cancellations/skips, with fresh source/build and isolated
PostgreSQL migrations in `4590eee3-1791983005529.log`. The new signed enquiry call
verifies caller and two patients with four codes, six private field finals,
played read notices, distinct appointment times, preserved first result, zero
clinical mutation and an empty database canary scan. A subsequent current-source
check including changed retired-read integrity passed14 checks, zero failures/
skips, in `4590eee3-1791983307892.log`.

Manifest1.196/388 records native/synthetic evidence; production full-call evidence
remains planned. Final frozen-source type/build, isolated PostgreSQL and broader
native/voice/core/storage/registry qualification runs as `Abby E388 enquiry task
final source voice native storage regression`, log
`4590eee3-1791983478330.log`. Publication awaits its terminal result.

Files: core enquiry completion and unchanged extracted notice-ID function,
transition next-task gate, private call-task receipt retirement, shared native
representative fixture, native/actual signed enquiry tests and registry/design/
implementation ledger. The full13 objective stays active. Other person/
operation/catalogue/staff combinations, unrelated representatives without a
native self record, alternative guardian channels, remaining gap6/8 work and
gaps10–13 remain unfinished, alongside actual clinic/mailbox/speech/carrier and
current authoritative CI acceptance.


Final frozen-source E2E-388 qualification completed exit0 in
`4590eee3-1791983478330.log`: whole-source typecheck, fresh compiled voice build,
isolated PostgreSQL migrations and173 native/private/signed/compiled/core/storage
and contract checks passed, zero failures/cancellations/skips, plus clean diff
check. Runtime source remained unchanged throughout the final gate.

Exact command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/representative-enquiry-tasks.test.ts test/voice/representative-enquiry-task-call.test.ts test/voice/appointment-enquiries.test.ts test/cliniko/representative-task-sequence.test.ts test/voice/representative-task-sequence-call.test.ts test/cliniko/call-task-sequence.test.ts test/voice/call-task-sequence-runner.test.ts test/cliniko/representative-workflow-start.test.ts test/cliniko/representative-call-owner.test.ts test/cliniko/representative-call-flow.test.ts test/cliniko/representative-workflow.test.ts test/cliniko/representative-appointment-change.test.ts test/cliniko/representative-selection.test.ts test/cliniko/native-validation-context.test.ts test/cliniko/booking-native-proof-bracket.test.ts test/cliniko/cliniko-call-flow.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-session.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-best-effort-edge.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/rescheduling-session.test.ts test/cliniko/rescheduling-authority.test.ts test/voice/representative-workflow-call.test.ts test/voice/private-representative-input.test.ts test/voice/private-representative-presentation.test.ts test/voice/representative-request-language.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/voice/openai-clinical-intent.test.ts test/voice/urgent-conversation-routing.test.ts test/voice/standalone-clinical-host.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/text/request-boundary.test.ts test/cliniko/request-boundary.test.ts test/storage/standalone-call-state.test.ts test/storage/postgres-portable-text-calls.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```

This qualifies the demonstrated read-only task sequence. It does not qualify all
patient/action combinations, real clinic/mailbox/speech/carrier acceptance or
current authoritative CI. The full13 objective and its remaining requirements
are retained above; PR457 stays draft until its required gates are established.


## Gap9 related-person cancellation, rescheduling and mixed read/change serving, E2E-389 (unpublished)

The existing native change owners now have actual CallFlow and signed private
serving qualification for related patients. Caller and selected patient each
verify through separate channels; the current representative and clinical
permissions remain independent. Actual target lists, move offers and clinical
consent must play before a native change. The caller's own appointment is
preserved. An enquiry for one person followed by another person's cancellation
obtains fresh operation-bound proof and preserves the first read. A cancellation
proof cannot authorize a move. Lost change responses remain uncertain and cannot
replay; current caller permission withdrawn after proposal denies mutation.

Changes are fixture/qualification work for existing production capabilities,
not invented new production behavior. Dedicated synthetic native records and
independent change approvals share the existing200-request account budget.
Fixture capability flags are explicit and default off. The signed fixture had
been replacing a PATCH target's patient with the calling patient when PATCH body
contained no patient ID. It now preserves the actual native pre-change patient
for readback. Existing self-call semantics and default single-write bound remain.
No dependency, schema migration, real sender, patient recordings or Twilio number
were added or activated.

Source preparation passed in `4590eee3-1791984124115.log`; actual native related
cancel/move and existing native/sequence qualification passed9 checks, zero
failures/skips, in `4590eee3-1791984298069.log`. Current source and mixed enquiry/
cancel/native task cases passed11 checks, zero failures/skips, in
`4590eee3-1791984500521.log`. The first signed source gate stopped on a new
test-only ActionState inference error (`4590eee3-1791984666781.log`); explicit
typing corrected it before repeat. Fresh source/build, isolated PostgreSQL and
actual signed cancel/move/mixed serving plus prior workflows passed27 checks,
zero failures/cancellations/skips, in `4590eee3-1791984762723.log`. The signed
cases scan isolated storage and public model/transcript/SAM for private name,
birth-date, recipient and code leakage; all scans are empty. Uncertainty/replay
and fresh caller-permission regression passed14 checks, zero failures/skips, in
`4590eee3-1791985026101.log`.

Manifest1.197/389 records native and synthetic serving evidence; production
full-call evidence remains planned. Final source/build/isolated PostgreSQL and
broader native/voice/core/storage/registry regression runs as `Abby E389 related
changes final source native serving storage regression`, log
`4590eee3-1791985123105.log`. Publication awaits that terminal result.

Files: opt-in fixture change capabilities, independent representative operation
approvals, native related change fixtures, preserved PATCH target identity,
native/mixed and actual signed change tests and registry/design/implementation
ledger. The full13 objective remains active. Other patient/operation/catalogue/
staff combinations, unrelated representatives without a native self record,
alternative guardian channels, remaining gap6/8 and gaps10–13 remain unfinished;
actual clinic/mailbox/model/acoustic/carrier acceptance and current authoritative
CI remain unproven.


Final E2E-389 qualification completed exit0 in
`4590eee3-1791985123105.log`: whole-source typecheck, fresh compiled voice build,
isolated PostgreSQL migrations and195 native/private/signed/compiled/core/storage
and contract checks passed, zero failures/cancellations/skips, plus clean diff
check. Source remained frozen during the qualification. The full thirteen-gap
objective remains active; these tests qualify the specified existing related
change workflows, not all class/payment/campaign/document capabilities or
production readiness.


## Gap10 existing class occurrences and private attendance reader, E2E-390 (unpublished)

`src/cliniko/class-attendance-read.ts` reads native existing class occurrences
and their attendee records. Session and attendee identities are distinct.
Current business/member/type relationships and verified patient proof are
required; complete class attendance is counted privately, including duplicate
registrations and overcapacity. Cancelled/archived/deleted attendance does not
consume a place. Only this patient's unique attendee reference can leave the
module. Group notes, native patient lists and every other patient's IDs/names/
notes are dropped. Reads are non-reservable observations, not membership or
write authority. No class-shared record is mutated and no local patient data
is persisted.

The native contract was checked against Cliniko's current official
[GroupAppointment schema](https://docs.api.cliniko.com/openapi/group-appointment/groupappointment),
[Attendee schema and operations](https://docs.api.cliniko.com/openapi/attendee),
and [OpenAPI description](https://docs.api.cliniko.com/_bundle/openapi.json?download=).
The reader uses `booking_id` with `/attendees`, including complete active
records for capacity. Deprecated per-group attendee routes are not required.
Existing concrete occurrence IDs may carry recurrence metadata; the reader
does not generate new occurrences or guess recurrence arithmetic.

Each native HTTP request reserves the existing shared account budget; response
bodies/pages are bounded, parent aborts/deadlines propagate, and no partial
result is returned. Two complete snapshots plus a final metadata and patient
check fence observed drift. Discovery currently bounds a query to30 sessions,
500 records per collection and90 days; exceeding a bound denies rather than
truncates. This establishes bounded reads, not atomic exclusion of concurrent
registrations. Ordinary class calling, booking/cancellation/movement, capacity
race recovery, independent class permissions, clinic approvals, memberships,
credits and serving qualification remain required to close gap10. Earlier open
gap6/8/9 requirements and all gaps11–13 are retained.

Initial typecheck passed; the provider run passed23 of24 cases in
`4590eee3-1791985867817.log`. The failing wrong-booking witness came from the
fixture filtering out its malformed row before returning it. The fixture now
returns the deliberately invalid row for reader rejection; the assertion is
unchanged. Corrected mismatch/complete-pagination qualification passed29 cases
in `4590eee3-1791985966579.log`. Metadata freshness passed30 in
`4590eee3-1791986023193.log`; impossible-date/config checks passed31 in
`4590eee3-1791986082527.log`. The final metadata-withdrawal witness and current
provider source passed32 cases, zero failures/cancellations/skips, in
`4590eee3-1791986120765.log`. Whole-source final qualification and publication
remain pending. Registry1.198/390 records read/provider evidence only, with
synthetic voice and production full-call evidence planned.


Final E2E-390 qualification completed exit0 in
`4590eee3-1791986198542.log`: whole-source typecheck and106 native class,
appointment, shared-budget, recall, roster, catalogue and registry checks
passed with zero failures/cancellations/skips, plus clean diff check. Source
was frozen throughout. This verifies the read/provider stage; class mutations
and caller-facing journeys remain unfinished and production evidence remains
planned.

Exact command:

```sh
npm run typecheck && node --test --test-concurrency=4 test/cliniko/class-attendance-read.test.ts test/cliniko/appointments.test.ts test/cliniko/shared-read-budget.test.ts test/cliniko/recalls.test.ts test/cliniko/roster-booking.test.ts test/cliniko/roster-large-calendar.test.ts test/cliniko/roster-calendar.test.ts test/cliniko/catalogue.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check
```


## Gap10 native single-attendee registration/cancellation, E2E-391 (unpublished)

`src/cliniko/class-attendance-write.ts` implements the documented native attendee
create and cancellation operations plus guarded exact-record inspection. The
trusted host must construct exact native patient/session targets and supply
current authority after the final shared account-budget wait. The test
authority reads actual native class capacity and unique own attendance through
E2E-390's module and independently checks permission. Missing authority, wrong
scope, full/duplicate attendance, another patient's cancellation target and
revocation deny a send or result. A same-action concurrent call reserves its
one-attempt key before asynchronous work. Lost response, an abort after provider
invocation or incorrect acknowledgement is uncertain; that action cannot replay
in this live writer. No ownership claim survives process loss on this basis.

Registration creates only `/attendees` with exact booking/patient IDs and an
opaque private attendee-note marker. Cancellation patches only its own attendee
and sets `apply_to_repeats: false`; it does not edit the shared class, another
patient, another occurrence, a membership credit or a refund. Exact guarded
readback checks patient/session/marker/status and rechecks independent authority
after the provider read. The official
[cancellation contract](https://docs.api.cliniko.com/openapi/attendee/cancelattendee-patch)
returns204 and provides an explicit repeat flag; acknowledgement is therefore
kept separate from inspected native evidence and caller confirmation.

The native race witness deliberately adds another attendee after creation,
so exact own-record inspection succeeds while the class is over capacity. This
is evidence that the caller-facing host still needs fresh post-write capacity
and review handling; no atomic capacity guarantee is invented. SAM consent,
approved class terms, membership/payment policy, owned Cliniko review/recovery,
class movement and actual signed/compiled serving integration remain required.
The writer is disconnected from production call routing and activates nothing.

The original reader fixture was extracted unchanged into
`test/support/class-attendance.ts`; reader assertions and registry paths remain.
Initial whole-source checking and reader regression passed in
`4590eee3-1791986517481.log`. Native read/write/current capacity and exact receipt
checks passed47 cases without failures/skips in
`4590eee3-1791986633320.log`. Current receipt-permission and pending-budget-abort
witnesses plus the reader passed49 cases, zero failures/cancellations/skips, in
`4590eee3-1791986791802.log`. Final whole-source and adjacent native/read/write
regression plus publication are pending. Registry1.199/391 records provider
evidence only; synthetic voice/full-call evidence remains planned. The full13
objective and every earlier open requirement remain active.


Final E2E-391 qualification completed exit0 in
`4590eee3-1791986903478.log`: whole-source typecheck, diff check and166 native
class/read/write/roster/catalogue/registry regression checks passed, zero
failures/cancellations/skips. Source remained frozen during this gate. This
qualifies the native attendance provider primitives, not class caller journeys
or complete gap10.

Exact command:

```sh
npm run typecheck && node --test --test-concurrency=4 test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/appointments.test.ts test/cliniko/shared-read-budget.test.ts test/cliniko/recalls.test.ts test/cliniko/booking-write.test.ts test/cliniko/cancellation-write.test.ts test/cliniko/reschedule-write.test.ts test/cliniko/roster-booking.test.ts test/cliniko/roster-large-calendar.test.ts test/cliniko/roster-calendar.test.ts test/cliniko/catalogue.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check
```


## Gap10 approved class booking through actual SAM and owned review, E2E-392 (unpublished)

A new `OwnerFileClassPolicy` requires exact selected business/member/type,
existing native occurrences, explicit best-effort and notification ownership,
versioned public labels/terms, bounded dates/expiry and approving clinic admin
membership. Ordinary appointment approval cannot enable class attendance.
`ClinikoClassBookingHost` owns private class menu/selection/preparation and
composes the existing actual book action/SAM rather than creating a shared
class. Actual caller proof and independent class/membership entitlement remain
separate. Only a played class proposal followed by an affirmative, current
settings/stop/live-call authority and an acknowledged Cliniko-owned review can
reach one attendee POST. Exact attendee marker/patient/session inspection and
fresh whole-class capacity are required before a committed receipt.

The class review protocol has its own versioned header and records the exact
class session and native attendance action marker. Its cancellation shape
distinguishes an attendee from a shared class; this protocol does not implement
a caller cancellation path. Provider-owned review discovery recognises the new
shapes without treating parsed notes as permission. Its synthetic process
helper reports positive class counts as non-patient aggregates while retaining
legacy aggregate shapes. Core booking offers optionally carry approved terms
with exactly their own expiry; terms enter the played confirmation and action
digest. Existing offers retain their wording. Protected native class reads now
propagate the caller abort to verification. No dependency/migration, patient
recording, real sender or Twilio number was added.

Current caller/class permission, approving membership, terms, native type or
capacity changes, write-stop, disposal, unplayed consent and guessed offers
deny send or disclosure. A lost review/write response remains uncertain, retains
Cliniko review work and cannot replay or later upgrade. A native create followed
by overcapacity or a duplicate own attendance also cannot become committed.
Class shared records and other patients are not edited. Caller presentations
exclude actual synthetic recipient, code, native patient and class-note canaries.
The positive path uses the actual unchanged shared200-request account budget.

Initial source checking stopped at the review-process helper's old operation
count union (`4590eee3-1791987670431.log`); explicit class aggregate cases fixed
it. The first native text fixtures used the wrong `begin()` return type,
invented menu command names, omitted the real text clock/greeting playback and
sent blank caller turns. They were corrected to the existing interfaces, actual
played admission greeting and complete turns without changing production
playback, limits or assertions. The complete native class journey passed in
`4590eee3-1791988188778.log`.

A subsequent source gate stopped on test-only asynchronous budget type and
un-narrowed presentation union (`4590eee3-1791988351345.log`); awaiting the actual
budget and requiring actual speech fixed these. Whole-source checking and82
class/native/current-approval/uncertainty/race plus ordinary booking/review
regressions passed without failures/skips in `4590eee3-1791988480591.log`.
A later foreign-policy witness expected a failed turn when the text shell
correctly accepts an unsuccessful request and presents a denial; its correction
now separately requires private host denial, explicit caller fallback, zero
class reads and zero actions/reviews/writes. The original red75-case evidence is
`4590eee3-1791988595754.log`; all75 current cases passed without failures/
cancellations/skips in `4590eee3-1791988790656.log`.

Registry1.200/392 records text/native evidence only. Final source/build, broader
PostgreSQL/process/voice/core/provider/registry qualification and publication
are pending. The full13 objective remains active. Ordinary signed/compiled class
routing, class cancellation/movement, membership/pass/credit adapters and clinic
acceptance remain unfinished; prior gap6/8/9 requirements and gaps11–13 remain.


Final E2E-392 qualification completed exit0 in
`4590eee3-1791989108987.log`: whole-source typecheck, fresh compiled voice build,
isolated PostgreSQL migrations and185 native class/SAM/owned review/process/
ordinary clinical voice/task/core/storage/registry checks passed with zero
failures/cancellations/skips, plus clean diff check. Source remained frozen
throughout. This qualifies the demonstrated text class-booking composition
and preserves existing serving regressions; it does not establish ordinary
class signed/compiled serving or close the full class/membership gap.

Exact command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-booking-host.test.ts test/cliniko/class-review-context.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-session.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/review-discovery.test.ts test/cliniko/review-discovery-process.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/reviewed-send-process.test.ts test/cliniko/review-rehearsal.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/call-task-sequence.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/voice/call-task-sequence-runner.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/storage/standalone-call-state.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```


## Gap10 exact class attendance cancellation through SAM and review, E2E-393

`ClinikoClassCancellationHost` composes the existing actual cancellation SAM
with cancellation-bound `CallerVerificationSession`, the explicit class service
approval and separate current cancellation/fee approval. It privately reads
existing native class occurrences and unique own attendees, issues opaque
target aliases and requires a played ordinal choice when several classes match.
Ambiguous own attendance denies the complete read. Independent class permission
is required before caller disclosure and rechecked at proposal, send and
inspection; the normal caller permission and current contact remain independent.
Class cancellation works while ordinary booking is disabled. A booking-only
channel proof cannot read or cancel class attendance.

The played confirmation binds the exact class time, approved class/instructor/
location and current standard/late fee wording to the action digest. A late-fee
boundary crossing, changed policy/member/target/type/permission, write-stop or
disposal denies the original send. An acknowledged class-specific Cliniko review
records the exact session and attendee before one possible attendee PATCH.
`apply_to_repeats:false` excludes later occurrences; shared class and other
patient records remain unchanged. Exact native readback and fresh class/proof/
policy checks precede a committed receipt. A lost response, changed inspected
patient, permission loss or new own attendance remains uncertain without
replay or later automatic upgrade. Saving review is not a human receipt, fee
charge, refund or membership credit adjustment.

The new native fixture uses the actual caller owner, synthetic registered
mailbox, independent clinical/class permissions and unchanged shared200-request
account budget. Private names/notes, recipient, code, native patient and target
refs do not enter caller presentations. The multiple-class witness selects the
second played option and inspects only its402 attendee/session94; the original
101 attendee/session91 remains active. No dependency/schema migration, real
sender, patient recording or Twilio number was added.

Initial source checking passed in `4590eee3-1791990142863.log`. The first actual
text journey passed in `4590eee3-1791990334297.log`. Current source and89 actual
SAM/authority/uncertainty/privacy/native class regressions passed with zero
failures/skips in `4590eee3-1791990685880.log`. Wrong-operation and fee-boundary
witnesses plus current class regression passed88 checks in
`4590eee3-1791990857208.log`. The latest whole-source check and92 class/native/
review regressions including the actual multiple-class choice passed without
failures/cancellations/skips in `4590eee3-1791991269280.log`.

Registry1.201/393 records text/native evidence only; final source/build and
broader PostgreSQL/process/voice/core/registry qualification plus publication
are pending. Ordinary signed/compiled class routing, class movement and
membership/pass/credit adapters remain unfinished. Prior gap6/8/9 work and
gaps11–13 remain active, alongside actual clinic/mailbox/model/acoustic/carrier
acceptance and authoritative CI. The full13 objective is unchanged.


Final E2E-393 qualification completed exit0 in
`4590eee3-1791991395944.log`: whole-source typecheck, fresh compiled voice build,
isolated PostgreSQL migrations and207 class/native/SAM/owned review/process/
ordinary clinical voice/task/core/storage/registry checks passed with zero
failures/cancellations/skips, plus clean diff check. The source was frozen
throughout this run. This proves the text class-cancellation composition and
existing serving regressions; ordinary class voice serving is still unfinished.

Exact command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-cancellation-host.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-review-context.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-session.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/review-discovery.test.ts test/cliniko/review-discovery-process.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/reviewed-send-process.test.ts test/cliniko/review-rehearsal.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/call-task-sequence.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/voice/call-task-sequence-runner.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/storage/standalone-call-state.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```


## Gap10 admitted class ownership and ordinary signed serving, E2E-394

A concrete `ClinikoClassSession` owns fresh operation-bound verification and
exactly one class booking or cancellation host under actual admission, active
lease, current settings, approved member and write-stop checks. Construction
captures the class service and separate caller/fee approvals and checks the
current method before publishing. Wrong-operation approval now fails at
preparation, rather than constructing an owner that can never obtain a grant.
Late preparation and call disposal revoke the private verifier and host.

An explicit class-attendance selector travels through ordinary workflow/query
and voice/reception seams. `ClinikoCallFlow` composes the concrete class owner;
its ordinary classifier sees only current approved class/instructor/location
labels. A class is never routed to an individual endpoint by default. Missing,
revoked and wrong-member/type approvals preserve the class boundary. Malformed
class decisions, unsupported movement and representative/service ambiguity
cannot select a default individual operation. The voice host freezes the class
binding before admitting calls. Each configured route currently selects one
class service; further catalogue and compiled subprocess coverage remain open.

Four synthetic signed HTTP/WebSocket journeys use the actual clinical resolver,
private keypad verifier, played class/time/fee confirmation, independent class
permission, owned Cliniko review and inspected attendee create/cancel. Lost
responses remain uncertain without replay. A spoken correction cancels the
first proposal and writes only the second class occurrence after separate
confirmation. Model/caller text and PostgreSQL exclude patient/code/recipient/
native-identity canaries. No real mail, patient audio, number or provider write
was used.

Initial preparation exposed a TypeScript operation-widening error, corrected
with the exact verifier-policy type. The source/owner test then found wrong
operation approval accepted at construction; current method checks now reject
it. Signed correction initially lacked the synthetic transport's actual clear
fence, then the provider fixture incorrectly checked the first canceled action.
It now observes the actual admitted call and exactly one dispatched action.
The call fixture also preserved the live budget getter rather than copying a
zero counter. The corrected witness proved inspection reached claim201 and
properly remained uncertain. Private correction mapping now reuses an already
issued offer like ordinal selection; fresh proposal/send inspection remains.
Exact own-attendee GETs are bracketed by current patient/class permission,
policy and dispatched SAM checks, followed by one mandatory complete native
class/capacity inspection before commitment, matching the cancellation path.
No budget, concurrency, deadline, permission or uncertainty gate was raised.

Current class/native/admitted owner/routing/signed regression passed118 checks,
zero failures/cancellations/skips in `4590eee3-1791993311574.log`. Earlier current
source typecheck, fresh compiled voice build and74 owner/routing/native/model/
signed checks passed in `4590eee3-1791992657928.log`. Final frozen-source broader
regression and publication are pending. Registry1.202/394 records the actual
text and synthetic signed evidence; full-call/carrier evidence stays planned.
Movement, membership/pass/credit processing and the remaining full13 work are
active. Billing prevents cloud execution but does not block local implementation.


Final E2E-394 frozen-source qualification completed exit0 in
`4590eee3-1791993463136.log`: whole-source typecheck, fresh compiled voice build,
isolated PostgreSQL migrations and251 class/native/admitted owner/normal
classifier/signed serving/ordinary clinical/compiled process/task/core/privacy/
registry checks passed with zero failures/cancellations/skips. Diff check passed.
The new corrected-class journey uses the live account-budget counter and the
actual clear fence; every successful attendance is read back and followed by
complete current native class/capacity inspection. Existing ordinary individual
and default unsupported-class serving remain qualified by this regression.

Exact command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-session.test.ts test/cliniko/class-call-flow.test.ts test/voice/class-workflow-call.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-review-context.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-session.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/review-discovery.test.ts test/cliniko/review-discovery-process.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/reviewed-send-process.test.ts test/cliniko/review-rehearsal.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/call-task-sequence.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/openai-clinical-intent.test.ts test/voice/booking-request-boundaries.test.ts test/voice/played-menu-selection.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/voice/call-task-sequence-runner.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/storage/standalone-call-state.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```

This is local synthetic qualification. The published branch still needs its
exact-head authoritative CI checks; billing rejection is not a test pass.
Compiled class subprocesses, multiple class services, movement, membership and
financial workflows remain open; the full thirteen-gap objective is active.


## Gap10 actual compiled class runner, E2E-395

A dedicated synthetic class runner calls the actual `serveClinikoVoice` entry
point with a concrete `ClinikoVoiceClinicalHost`, the runner's physical shared
PostgreSQL request budget and contact-revision owner. It keeps actual metadata
selection, signed admission, allowlist, readiness and ordinary clinical intent.
It privately verifies caller codes and requires played class/time/fee consent
before native attendance writes. One occurrence cancellation excludes repeats.
Native fixture metadata supplies real required catalogue fields and validates
the User-Agent against the explicitly configured test contact address; default
class fixture expectations remain unchanged. The compiled harness selects this
separate entry point only when its explicit test option requests classes.

Sixteen compiled journeys cover exact booking/cancellation, lost native response
and no replay, independent caller/class permission denial after consent,
withdrawn class approval, current policy changes, denied caller authority,
failed mail, capacity loss before send and overcapacity after create. The latter
leaves one acknowledged review and an unresolved attendance, with no second
write on an outcome query. Booking/cancellation use no individual appointment
endpoint. Non-allowlisted callers and general readiness remain disabled.
Canary scans cover the actual child's public model/transcription, output and
PostgreSQL. No real patient audio, mail, number or provider writes were used.

Initial source/build preparation passed, but the first actual compiled booking
remained uncertain in `4590eee3-1791994291975.log`: the runner rebinds the host's
contact-revision owner and the fixture's SAM observer was attached to the old
host. The test observer now follows actual rebindings and retains every played,
unique dispatched-action assertion; no runtime gate was bypassed. The corrected
first compiled journey passed in `4590eee3-1791994492349.log`. The complete first
matrix and adjacent tests passed92 checks with zero failures/skips in
`4590eee3-1791994610679.log`. Current source typecheck, fresh compiled voice build
and the extended16-journey/native/owner/routing/signed regression passed94
checks, zero failures/cancellations/skips in `4590eee3-1791994820937.log`.

Registry1.203/395 records synthetic compiled evidence; full-call/carrier evidence
stays planned. Final frozen-source broader regression and publication are pending.
Multiple class services, movement, independent membership/pass/credits and
remaining gaps6/8/9/11/12/13 plus actual acceptance and cloud qualification remain
unfinished. The full thirteen-gap objective is active.


The first combined E2E-395 final run failed one of267 checks in
`4590eee3-1791995114481.log`: a compiled cancellation correctly remained
uncertain after writing, while the other266 checks passed. Targeted cancellation
with ordinary compiled/native load and new fixed-code diagnostics passed16
checks in `4590eee3-1791995500404.log`. The diagnostic combined run failed a
booking instead, again266/267, in `4590eee3-1791995678729.log`; the physical
budget showed154/180 requests and a9.5-second write, excluding exhaustion and
the30-second effect deadline. Cancellation completed at156/180 in that run.

Source inspection identified a real lifecycle defect in `ClinikoClassSession`:
the verifier's ongoing policy predicate captured the preparation's15-second
signal. Thus a successfully prepared owner lost authority later in a long call.
Two patient-free book/cancel regressions reproduced it deterministically after
a configured preparation deadline: neither could issue a code. Red evidence:
`4590eee3-1791996137275.log`. Ongoing policy now uses only the actual live call
and disposal signal; construction still races its unchanged preparation
deadline and rejects late owners. Closed/revoked/stop checks remain mandatory.
The corrected paused-verification/native scope regression passed66 checks with
zero failures/skips in `4590eee3-1791996174378.log`. A separate delayed-directory
case asserts no owner/challenge/mutation after preparation times out.
Positive compiled receipts now assert the exact confirmed wording and a
committed host result, excluding an accidental match of "unconfirmed".
No rate limit, worker count, deadline, permission or uncertainty rule was raised.
Current-source final qualification must include this fix and the new regressions.


The next corrected-source combined run in `4590eee3-1791996240857.log` passed269
checks with zero assertion failures, but canceled the new delayed-directory test
because its artificial pending Promise had no live I/O handle (preparation's
AbortSignal timer is intentionally unreferenced). Both compiled exact receipts
were committed after the former15-second boundary:155/180 booking requests and
156/180 cancellation requests. The controlled directory fixture now retains a
bounded real timer handle and a5-second test deadline, preserving the same
100ms preparation timeout and all no-owner/no-code/no-mutation assertions.
All21 current admitted-session checks then passed without failures/cancellations/
skips in `4590eee3-1791996615024.log`. A final complete frozen-source run remains
required before publication. The earlier canceled run is not called a pass.


Final E2E-395 frozen-source qualification completed exit0 in
`4590eee3-1791996713237.log`: whole-source typecheck, fresh separately compiled
voice build, isolated PostgreSQL migrations and270 class/native/admitted owner/
normal intent/signed/compiled runner/ordinary clinical/task/core/privacy/registry
checks passed, zero failures/cancellations/skips, followed by clean diff check.
The16 compiled class journeys retain current permissions, policy, approval,
physical PostgreSQL budget and native inspection. The live-call verifier fix,
two paused-after-preparation positive journeys and the delayed-directory negative
case are included. A new actual cancellation completed after the previous
15-second deadline with156/180 physical requests; the limit and all operational
deadlines/concurrency remain unchanged. No real clinic/mail/model/acoustic/
carrier acceptance or full class/membership parity is claimed.

Exact command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && ABBY_CLASS_DIAGNOSTICS=1 node --test --test-concurrency=4 test/voice/class-runner.test.ts test/cliniko/class-session.test.ts test/cliniko/class-call-flow.test.ts test/voice/class-workflow-call.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-review-context.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-session.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/review-discovery.test.ts test/cliniko/review-discovery-process.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/reviewed-send-process.test.ts test/cliniko/review-rehearsal.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/call-task-sequence.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/openai-clinical-intent.test.ts test/voice/booking-request-boundaries.test.ts test/voice/played-menu-selection.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/voice/call-task-sequence-runner.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/storage/standalone-call-state.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```

The published commit still requires authoritative cloud execution. Multiple
class-service selection, class movement, independently owned membership/pass/
credits and the remaining thirteen-gap requirements remain active.


## Gap10 multiple approved class services, E2E-396

`ClinikoCallFlowConfig.classServices` supports 1–32 explicitly approved services;
its singular predecessor remains compatible and cannot be configured alongside it.
Every entry must pass current scope/account/actor/member/type approval; invalid or
duplicate entries reject the complete catalogue. Questions present three class,
instructor, duration and location labels per page. Ordinal responses require the
actual preceding question to have played. A volatile single-use selection binds
call, session, actual selecting turn, conversation revision, operation, complete
current approval version and expiry. Neither the model nor a public service name
can supply native bindings or grant patient/membership authority.

Normal core, TextReception, VoiceSession and clinical resolver carry the choice
to a new concrete class owner and its exact permission port. Fresh patient proof,
played class/time/fee terms, affirmative consent, owned review, single attendance
write and native inspection remain required. Cancellation-only policies work
while booking is disabled. Both admitted and current operation/staff settings
are checked before presenting a class question. The selecting turn is validated
before class owner preparation.

Nineteen focused cases cover different native services, cancellation without
booking, stale/unplayed/revoked/changed/expired/stopped selection, incomplete or
duplicate catalogue entries, wrong native bindings, exact names, paged choices,
wrong-turn/operation/forged selection and current setting withdrawal. Two actual
compiled signed HTTP/WebSocket journeys use the real runner/host factory, private
keypad, shared PostgreSQL budget/contact revision and SAM to select Reformer
Pilates with a different instructor and 30-minute duration for booking/cancel.
The original Mat Pilates attendance remains unchanged. Privacy scans cover
patient/code canaries in public model/transcription/output and PostgreSQL.

The focused native/compiled pre-final gate passed in
`4590eee3-1791998150348.log` (16 native checks plus two compiled journeys,
whole-source typecheck and fresh voice build). Subsequent improvements restrict
provider-side service filtering to the explicit multi-service fixture, preserving
existing malformed-native-response tests, and check current operation/staff
settings before issuing questions. Final frozen-source qualification completed
exit0 in `4590eee3-1791998409948.log` in 5m26s: whole-source typecheck, fresh
compiled build, isolated PostgreSQL migration and291 checks passed with zero
failures/cancellations/skips, plus clean diff check. Registry1.204 records396
stable scenarios. Authoritative cloud execution remains required.
No real clinic/mail/acoustic/carrier acceptance, class movement, financial
credits/passes or completion of the full13 objective is claimed.

Exact final validation command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-service-selection.test.ts test/voice/class-service-runner.test.ts test/voice/class-runner.test.ts test/cliniko/class-session.test.ts test/cliniko/class-call-flow.test.ts test/voice/class-workflow-call.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-review-context.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-session.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/review-discovery.test.ts test/cliniko/review-discovery-process.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/reviewed-send-process.test.ts test/cliniko/review-rehearsal.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/call-task-sequence.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/openai-clinical-intent.test.ts test/voice/booking-request-boundaries.test.ts test/voice/played-menu-selection.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/voice/call-task-sequence-runner.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/storage/standalone-call-state.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```


## Gap10 native class movement and partial-failure recovery, E2E-397

The official [Cliniko attendee API](https://docs.api.cliniko.com/openapi/attendee),
checked 2026-10-14, permits class attendance creation and occurrence cancellation;
its attendee-update request does not change the booking identity. Movement uses
an explicit non-atomic sequence in `ClinikoClassAttendanceMove`: create the new
attendance, inspect its exact acknowledgement, check both current occurrences
and capacity, cancel the original, inspect its exact cancellation and check both
final occurrences. Only those observations can yield a moved outcome. No shared
class, repeat series, other patient, pass, invoice or refund is modified.

A trusted phase authority remains mandatory and must represent current move/fee/
recovery consent, dispatched SAM, source/destination approvals, membership rights
and write-stop state. Native patient proof and current capacity independently
surround each send. This module is an internal composition foundation; it is not
yet the admitted call owner or a conversational movement capability.

If original cancellation was never sent, an independently authorised compensation
may cancel only the exact replacement, then inspect that cancellation and prove
that the original attendance remains active. An unknown create, original cancel
or compensation result stays unresolved. Neither another call nor a timeout
replays the same root action or rolls back an original cancellation that might
have succeeded. Current authority loss, expired consent, disconnection, record
or capacity drift and failed inspections never become confirmed moves.

`inspectPair` reads exactly two selected occurrences with current metadata/proof
and two matching native snapshots. Source and destination bindings are checked
against each exact endpoint response. It shares work within that observation;
it does not cache capacity across stages. Distinct class services retain separate
native readers. Different instructor/type/duration movement and known-unsent
compensation pass under the unchanged180-request account test budget.

A dedicated strict `classMove` review envelope records original/new occurrences,
exact instructor/type/time bindings, cancellation reason, explicit compensation
boundary and root action marker before any attendance write. Leg identifiers
are derived from that root. Review discovery recognises this operation as manual
work. A killed sender loses transient context; a new process discovers the
provider-owned record without the lost patient/marker and performs no mutation.
Aggregate output, PostgreSQL and disposable backup scans exclude private canaries.

First native proof:82 checks passed, but typecheck correctly failed because the
review-discovery fixture worker had no aggregate classMove branch
(`4590eee3-1791999225361.log`). The branch was added without changing existing
counts. Expanded89 native checks, whole-source typecheck, isolated migration and
both existing appointment and new class-move sender-death/rediscovery journeys
then passed in `4590eee3-1791999442924.log` (exit0). Subsequent changes place the
review-owning coordinator in standalone composition, preserve exact paired
endpoint identity, and add strict move-envelope and aborted-pending-authority
cases. Final combined source qualification remains required before publication.

Admitted class move ownership, operation-bound verification, menu/proposal/played
consent, signed/compiled movement serving and membership/pass/credit authority
remain unfinished. No production activation, real patient/mail/carrier use or
completion of the full13 objective is claimed.


The first combined qualification completed331 checks with330 passing and one
registry failure (`4590eee3-1791999635930.log`): the new native-only row incorrectly
used syntheticImplemented while its voice evidence is planned. It now uses
textImplemented; no voice execution is inferred from native contracts.

Six new permission-withdrawal cases then reproduced a real pre-publication race
(`4590eee3-1791999943381.log`, six failures): an independent move permission could
be withdrawn during the native snapshot after its initial check. Current phase
authority is now checked again after each native observation, before the review
or attendance send and before moved/restored classification. Paired native
observations and exact receipts remain mandatory. The corrected81-case focused
move/read/envelope/registry gate passes with zero failures/cancellations/skips
in `4590eee3-1791999985518.log`. The earlier combined run is not called a pass.
A final frozen-source combined gate is required before publication.


Final corrected frozen-source qualification completed exit0 in5m17s in
`4590eee3-1792000023652.log`: whole-source typecheck, fresh compiled voice build,
isolated PostgreSQL migrations and337 native/read/write/review/recovery/class/
ordinary-call/core/privacy/registry checks passed with zero failures,
cancellations or skips, followed by clean diff check. All six reproduced
permission-withdrawal races and both killed-sender/fresh-discovery subprocess
journeys are included. Registry1.205/397 retains native contract evidence and
planned conversational move evidence. No limits, deadlines or concurrency were
raised. Admitted move/SAM/voice integration and the full13 requirements remain
unfinished; authoritative cloud validation is still required.

Exact final validation command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-attendance-move.test.ts test/cliniko/class-service-selection.test.ts test/voice/class-service-runner.test.ts test/voice/class-runner.test.ts test/cliniko/class-session.test.ts test/cliniko/class-call-flow.test.ts test/voice/class-workflow-call.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-review-context.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-session.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/review-discovery.test.ts test/cliniko/review-discovery-process.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/reviewed-send-process.test.ts test/cliniko/review-rehearsal.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/call-task-sequence.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/openai-clinical-intent.test.ts test/voice/booking-request-boundaries.test.ts test/voice/played-menu-selection.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/voice/call-task-sequence-runner.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/storage/standalone-call-state.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```


## Gap10 protected class move host and played SAM consent, E2E-398

`ClinikoClassMoveHost` now privately selects the original owned attendance and
replacement occurrence with actual played target/offer menus, operation-bound
caller verification, independent per-phase movement authority and three current
owner approvals. Fee and non-atomic recovery terms are bound to the proposal and
played confirmation. Explicit service replacement names original and destination
classes and is rejected by the individual in-place provider adapter. Cancellation
and booking settings do not imply rescheduling permission. No admitted ordinary
call/voice movement or membership/pass/credit authority is claimed yet.

Native proof refresh must be sequential across service readers: the physical
email authority has an exclusive refresh and concurrent refreshes invalidated
each other. Candidate menus now use an explicitly non-reserving single snapshot;
strict proposal, pre-send and post-send observations retain full double snapshots
and capacity checks. Phase permission is checked after native observations.
Unknown owned-review replies propagate uncertainty through SAM instead of being
misreported as rejection. No unknown leg is replayed or rolled back.

Same-service movement completes within one 180-request account window. Different
service/instructor/duration movement is qualified after a 61-second caller pause
with actual lease renewal and a fresh account window. A shared-budget headroom
check (memory and PostgreSQL) rejects known inadequate quota before review or
attendance changes. It does not consume/reserve quota or avoid ordinary claims,
so concurrent account use can still produce an unresolved move. Pacing/retry in
admitted conversational serving remains unfinished.

A new red test reproduced minimum-notice crossing while the caller paused:
`Abby E398 reproduce destination notice crossing before commit` failed because
attendance changes were sent after the destination crossed its 60-minute rule.
The host now rechecks destination notice, horizon and duration whenever it
reconstructs the request, including before the first review and every native
phase. The corrected host and individual-projection gate completed exit0 in
`4590eee3-1792002310125.log`. Earlier 105 focused checks, typecheck and seven
isolated PostgreSQL budget checks passed in `4590eee3-1792001981196.log`; they
precede this timing correction and are not the final combined gate.

Final frozen-source qualification command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-move-host.test.ts test/cliniko/shared-read-budget.test.ts test/cliniko/class-attendance-move.test.ts test/cliniko/class-service-selection.test.ts test/voice/class-service-runner.test.ts test/voice/class-runner.test.ts test/cliniko/class-session.test.ts test/cliniko/class-call-flow.test.ts test/voice/class-workflow-call.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-review-context.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-session.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/review-discovery.test.ts test/cliniko/review-discovery-process.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/reviewed-send-process.test.ts test/cliniko/review-rehearsal.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/call-task-sequence.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/openai-clinical-intent.test.ts test/voice/booking-request-boundaries.test.ts test/voice/played-menu-selection.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/voice/call-task-sequence-runner.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/storage/standalone-call-state.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test test/storage/postgres-cliniko-request-budget.test.ts" && git diff --check
```


Final frozen-source gate completed exit0 in4m50s in
`4590eee3-1792002376918.log`: whole-source typecheck, fresh compiled voice build,
isolated PostgreSQL migrations,368 combined source/SAM/native/review/recovery/
ordinary signed and compiled class/voice/privacy/registry checks and seven
separate real PostgreSQL shared-budget checks passed with zero failures,
cancellations or skips, followed by clean diff check. Registry1.206/398 records
text evidence only. No dependencies, migrations, limits, deadlines or concurrency
were changed. Admitted ordinary movement, caller-facing budget pacing, financial
entitlements, cloud qualification and the full13 requirements remain open.


## Gap10 admitted ordinary class movement and signed voice, E2E-399

`ClinikoClassSession` now owns a fresh rescheduling verifier, current source,
destination and service-pair movement approvals, independent patient and class
phase permission, and the protected SAM move host. Existing book/cancel sessions
retain separate proofs and settings. The call admission, live lease, identity
denial and write stop are checked before publishing or releasing a grant.

Class catalogues expose move availability only for a current approved pair.
Movement can be selected through played public service choices while booking
and cancellation are disabled. Unavailable move approval removes movement
availability and does not remove an otherwise approved class service. Pair
approvals participate in catalogue version/expiry, invalidating stale choices.
Ordinary finite and model routing now select class rescheduling; the model
cannot supply a private service handle or opt an unapproved class into movement.
The ordinary prompt is version31. Class and individual provider paths stay
separate. Signed synthetic voice requires actual private keypad verification,
played source/replacement menus, played fee/recovery consent and separate
affirmation before one owned review and exact native replacement/original legs.
Lost original cancellation replies remain uncertain; repeated affirmation does
not replay. Permission withdrawn after consent prevents both attendance writes.

Initial owner regression completed68/69 while typecheck overlapped the run:
one pre-existing same-service menu expired after44seconds at33 physical claims.
After compilation completed, the unchanged69 checks passed in14seconds in
`4590eee3-1792002884018.log`. No deadline or concurrency was raised. The expanded
ordinary source/routing gate then passed typecheck and60 checks in
`4590eee3-1792003077454.log`. Initial signed movement failed all three journeys
because ordinary target reads use canonical timestamp ranges, while the new
host accepted date-only ranges (`4590eee3-1792003235090.log`). The host now
accepts bounded canonical target instants with its existing horizon and duration
limits. The corrected actual signed movement gate passes all four checks in
`4590eee3-1792003305611.log`, including PostgreSQL canary scans. Current class
choice/approval gates pass58 checks in `4590eee3-1792003382927.log`; explicit
model movement and played selection pass11 in `4590eee3-1792003456381.log`.
These are focused results; combined frozen-source qualification remains required.

Compiled class movement, pre-send correction, caller-facing budget pacing and
financial membership/pass/credit work remain unfinished. Real clinic/mail/
carrier/acoustic acceptance and authoritative cloud qualification remain absent.
No completion of gap10 or the full13 objective is claimed.

Final frozen-source qualification command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-move-session.test.ts test/cliniko/class-move-call-flow.test.ts test/voice/class-move-workflow-call.test.ts test/cliniko/class-move-host.test.ts test/cliniko/shared-read-budget.test.ts test/cliniko/class-attendance-move.test.ts test/cliniko/class-service-selection.test.ts test/voice/class-service-runner.test.ts test/voice/class-runner.test.ts test/cliniko/class-session.test.ts test/cliniko/class-call-flow.test.ts test/voice/class-workflow-call.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-review-context.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-session.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/cliniko/review-discovery.test.ts test/cliniko/review-discovery-process.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/reviewed-send-process.test.ts test/cliniko/review-rehearsal.test.ts test/cliniko/cancellation-review-context.test.ts test/cliniko/call-task-sequence.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/openai-clinical-intent.test.ts test/voice/booking-request-boundaries.test.ts test/voice/played-menu-selection.test.ts test/voice/standalone-clinical-runner.test.ts test/voice/caller-identity-denial.test.ts test/voice/call-task-sequence-runner.test.ts test/text/booking.test.ts test/text/uncertain.test.ts test/storage/standalone-call-state.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test test/storage/postgres-cliniko-request-budget.test.ts" && git diff --check
```


Final frozen-source qualification completed exit0 in4m28s in
`4590eee3-1792003527110.log`: whole-source typecheck, fresh compiled voice build,
isolated migrations,407 combined native/read/write/review/recovery/admitted
class movement/ordinary signed voice/existing compiled class/privacy/registry
checks and seven separate PostgreSQL budget checks passed with zero failures,
cancellations or skips, followed by clean diff check. Registry1.207/399 records
actual synthetic signed movement and planned full-call evidence. No dependencies,
migrations, request limits, deadlines or concurrency were changed. Compiled
movement, corrections, conversational budget pacing, membership/pass/credits,
remaining full13 requirements and authoritative cloud qualification remain open.


## Gap10 separately compiled class movement and truthful quota recovery, E2E-400

The existing synthetic class runner now provisions reschedule sessions through
the actual exported runner and host/contact-revision rebinding. It uses the
physical shared PostgreSQL request budget, signed admission/allowlist, private
keypad proof and actual dispatched/played SAM assertions at each attendance
mutation. Single and catalogue configurations reach one bounded owned review
and exact replacement/original legs. Lost review, replacement and original
responses remain unresolved without replay or rollback. Current patient/class
permission, source/destination/pair approvals, approving membership, policy and
capacity withdrawal after consent prevent mutations. Failed code delivery or
independent caller denial cannot grant patient authority. Public model/media,
child output and PostgreSQL exclude code/email/patient canaries. No production
code, dependencies, migrations, request limits or deadlines are changed.

The first complete compiled movement passed whole-source typecheck, fresh build
and one actual runner journey in `4590eee3-1792004028007.log` (exit0). The expanded
gate passed16 of17 checks in `4590eee3-1792004266636.log`. Its simulated capacity
race was initially replayed after every native write and created duplicate
fixture IDs during compensation. The race hook now runs only after replacement
creation. The targeted correction still correctly stayed uncertain
(`4590eee3-1792004389017.log`): a further diagnostic in
`4590eee3-1792004482893.log` proved that the real shared budget had180 of180
claims used during final recovery observation, with current inspection
permission still allowed. The replacement cancellation was sent and the
original had not been cancelled, but complete restoration was not verified.
The assertion now explicitly requires an uncertain outcome, budget exhaustion
and no replay for that case. A separately qualified known-unsent cancellation
case still requires fully inspected recovery and a rejected move outcome.
This is truthful best-effort handling, not completion of account-budget pacing.

The complete current seventeen-case gate passed exit0 in55seconds in
`4590eee3-1792004572389.log`, with zero failures/cancellations/skips. The final gate covers changed compiled runner provisioning and
existing book/cancel/multiple-service paths; unchanged native adapters retain
the407+7 combined source qualification from E2E-399. Corrections, conversational
budget pacing, cross-service compiled movement and membership/pass/credit
processing remain unfinished, along with the remaining thirteen-gap objective.
Cloud qualification and real clinic/mail/acoustic/carrier acceptance are absent.

Exact final command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/voice/class-move-runner.test.ts test/voice/class-runner.test.ts test/voice/class-service-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```


Final frozen-source qualification completed exit0 in3m06s in
`4590eee3-1792004669474.log`: whole-source typecheck, fresh compiled voice build,
isolated migrations and37 current compiled movement/existing class booking/
cancellation/multiple-service/registry checks passed, zero failures,
cancellations or skips, followed by clean diff check. Registry1.208/400 records
actual compiled synthetic movement. Unchanged native/SAM/signed adapters retain
the407+7 source evidence in E2E-399. Request limits, deadlines, concurrency,
dependencies and production source are unchanged. The quota-exhausted final
recovery observation remains explicitly uncertain; budget pacing and the
remaining class/financial and full thirteen-gap requirements remain open.


## Gap10 pre-send class move correction and renewed consent, E2E-401

`ClinikoClassMoveHost` retains the privately issued played replacement menu.
Correction maps only an existing option to its private offer reference after
the old SAM preparation is cancelled. The original target, caller/session,
played menu, current source/destination/move approvals, permission, expiry and
conversation are checked. Mapping an offer is not authority: ordinary proposal
resolution re-inspects both exact native occurrences before creating new SAM
consent. A new-date menu may retain only the original target reference derived
from that cancelled request; a foreign target is rejected. New reads and
disposal clear the previous menu. Once a send attempt starts, correction cannot
replay it. The ordinary call flow delegates correction to its current individual
or class rescheduling owner through the same existing seam.

The first typecheck and nine actual text/native correction checks passed in
`4590eee3-1792004994104.log` (exit0). Both played-ordinal and new-date corrections
complete same-service and different-service/duration moves after a61-second
caller pause with actual lease renewal; every physical request still claims
the unchanged180-request account budget. Old consent stays cancelled and only
the new occurrence is booked before original attendance cancellation. Current
permission/approval loss, expiry, foreign target and attempted/committed work
cannot send. Added full-replacement and changed-original cases independently
exercise strict native evidence after the private corrected selection.

The first signed preparation gate failed because its synthetic model fixture
used a private reschedulingTargetSelected field that the public model never
receives (`4590eee3-1792005219955.log`). It now uses the actual public phase and
explicit fixture utterance. All four corrected signed checks pass in
`4590eee3-1792005304058.log`: ordinal/date corrections interrupt and cancel the
first consent, prepare a new unplayed proposal and send no native writes;
withdrawn permission cannot prepare one. Public model/media and PostgreSQL
canary scans retain privacy. This is signed correction preparation evidence,
not proof of corrected signed commitment across an account quota window.

Conversational budget pacing, complete signed/compiled corrected commitments,
cross-service compiled movement and membership/pass/credit handling remain
unfinished. No full gap10 or full13 completion, actual clinic/mail/model/
acoustic/carrier acceptance or cloud qualification is claimed.

Final frozen-source command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh bash -c "npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-move-correction.test.ts test/voice/class-move-correction-call.test.ts test/cliniko/class-move-host.test.ts test/cliniko/class-move-session.test.ts test/cliniko/class-move-call-flow.test.ts test/cliniko/class-attendance-move.test.ts test/cliniko/class-service-selection.test.ts test/voice/class-workflow-call.test.ts test/voice/class-move-workflow-call.test.ts test/voice/class-move-runner.test.ts test/voice/class-service-runner.test.ts test/voice/class-runner.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/standalone-rescheduling.test.ts test/voice/cliniko-workflow-call.test.ts test/voice/clinical-model-workflow-call.test.ts test/voice/played-menu-selection.test.ts test/voice/played-menu-navigation.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts" && git diff --check
```


Final frozen-source qualification completed exit0 in4m42s in
`4590eee3-1792005394941.log`: whole-source typecheck, fresh compiled voice build,
isolated migrations and252 class/native/SAM/correction/signed/compiled/ordinary
individual rescheduling/privacy/registry checks passed, with zero failures,
cancellations or skips, followed by clean diff check. The two added full-
replacement and changed-original cases are included. Registry1.209/401 retains
planned full-call evidence and describes the narrower signed preparation scope
explicitly. No dependencies, migrations, request limits, deadlines or concurrency
were changed. Complete corrected signed/compiled commitment across quota windows,
quota-aware pacing, cross-service compiled movement and membership/pass/credits
remain unfinished, as do the remaining full13 requirements and cloud acceptance.


## Gap10 class movement capacity pacing and full corrected commitment, E2E-402

Known insufficient account capacity is now checked before SAM confirmation
creates a write effect. A bounded played notice explains that the original is
unchanged and the replacement is not reserved, retains only the exact unsent
move, and asks the caller to say yes again after recovery. The voice listening
interval reflects that explicit wait. The wait never reserves API requests,
authorizes a write, extends proof/offer/effect deadlines or changes the physical
180-request limit. Dispatch retains its own headroom check and every native
request still claims normally. The authoritative native evidence/fee/recovery
protocol is unchanged. Concurrent late quota loss can still prevent complete
recovery inspection and remains uncertain.

The optional host capacity seam is advisory. Text reception captures the current
conversation revision and bounds the read to five seconds. Voice barge-in aborts
that pending read. The class owner rechecks current exact proposal, played consent,
source/destination/move approvals, permission, call lease and expiry before and
after reading capacity. Memory and PostgreSQL budgets report relative delay on
their own clocks, avoiding conversion against an unrelated clinic fixture clock.
Permission/approval loss, expired evidence, correction, external abort and stale
revision cannot turn a delayed capacity response into write authority.

Local evidence:

- Native/text capacity and delayed-read tests plus shared budget checks pass15/15
  in `4590eee3-1792006726839.log`.
- Whole-source typecheck and63 confirmation/native/correction/lease/silence tests
  pass in `4590eee3-1792006805445.log`.
- Signed same-service and different instructor/type/duration ordinal corrected movements
  pass after a real61-second quiet wait, actual connected-call lease renewal and
  a second affirmative. Only corrected occurrence95 is created, then original101
  is cancelled. Ten signed correction/movement checks pass in
  `4590eee3-1792006766352.log`; public model/media and PostgreSQL scans exclude
  patient/email/code canaries.
- PostgreSQL shared budget tests pass7/7 in
  `4590eee3-1792006766570.log`. The existing compiled movement family passes17/17
  in that log; its first new correction fixture timed out because the helper did
  not return the pending playback/clear receipt. The new compiled path now plays
  the first confirmation before correcting it. Signed tests independently cover
  interruption during the earlier confirmation.
- Separately compiled ordinal corrected cross-service movement passes1/1 in
  `4590eee3-1792006882723.log`: actual exported runner and host/contact-revision
  rebinding, real database quota window, continuous quiet media, normal lease
  renewal, played new consent, one owned movement review and exactly the two
  inspected native mutations. Actual180-request limit and privacy scans pass.

The initial signed minute-wait fixture advanced its clinic clock while omitting
quiet media. The second affirmative consequently carried old stream timestamps
and was denied with no native write (`4590eee3-1792006505314.log` and diagnostic
`4590eee3-1792006677587.log`). Continuous quiet media at normal frame pacing fixes
the fixture without relaxing the freshness gate. An initial compiled typecheck
also caught two unvalidated unknown database JSON values; both now require array
validation before length assertions.

Registry1.210 tracks402 stable scenarios. Full-call evidence remains planned.
Full dated-correction signed/compiled commitments, membership/pass/credit
handling, broader catalogue/operator acceptance, the remaining full13 requirements and actual clinic/mail/acoustic/carrier and cloud
qualification remain open. No dependency or migration is added.

Final frozen-source qualification completed exit0 in4m40s in
`4590eee3-1792007055895.log`: whole-source typecheck, fresh compiled voice build,
isolated migrations, seven PostgreSQL account-budget checks and283 affected
native/SAM/class/individual/signed/compiled/correction/lease/silence/privacy/registry
checks pass, zero failures/cancellations/skips, followed by clean diff check.
The exact executed script was `bash /tmp/abby-e402-final.sh`:

```sh
#!/usr/bin/env bash
set -euo pipefail
cd /home/gust/code/abby-integrated-runner
npm run typecheck
npm run build:voice-tests
bash scripts/with-postgres.sh bash -c '
set -euo pipefail
npm run db:migrate
node --test test/storage/postgres-cliniko-request-budget.test.ts
node --test --test-concurrency=4 \
  test/cliniko/class-move-capacity.test.ts \
  test/cliniko/shared-read-budget.test.ts \
  test/voice/class-move-capacity-call.test.ts \
  test/voice/class-move-capacity-runner.test.ts \
  test/cliniko/class-move-correction.test.ts \
  test/voice/class-move-correction-call.test.ts \
  test/cliniko/class-move-host.test.ts \
  test/cliniko/class-move-session.test.ts \
  test/cliniko/class-move-call-flow.test.ts \
  test/cliniko/class-attendance-move.test.ts \
  test/cliniko/class-service-selection.test.ts \
  test/voice/class-workflow-call.test.ts \
  test/voice/class-move-workflow-call.test.ts \
  test/voice/class-move-runner.test.ts \
  test/voice/class-service-runner.test.ts \
  test/voice/class-runner.test.ts \
  test/cliniko/class-booking-host.test.ts \
  test/cliniko/class-cancellation-host.test.ts \
  test/cliniko/standalone-rescheduling.test.ts \
  test/voice/cliniko-workflow-call.test.ts \
  test/voice/clinical-model-workflow-call.test.ts \
  test/voice/played-menu-selection.test.ts \
  test/voice/played-menu-navigation.test.ts \
  test/voice/twilio-silence-timeout.test.ts \
  test/voice/final-negative-corrections.test.ts \
  test/voice/caller-corrections.test.ts \
  test/voice/voice-lease-loop.test.ts \
  test/text/correction.test.ts \
  test/contract/scenario-manifest.test.ts \
  test/contract/no-number-gap-trace.test.ts
'
git diff --check
```

The later prose refinement explicitly limits the new complete correction evidence
to ordinal selections. The registry contract is checked again after that edit.


## Next class package authority investigation, 14 October2026

Cliniko documents package tracking through patient cases, optionally with account
credit; a case/session counter alone does not prove a payment or monetary refund.
Its package guidance distinguishes prepaid invoicing from account-credit allocation
and makes cancellation/DNA counting a case setting. See
[Cliniko package tracking](https://help.cliniko.com/en/articles/6477363-tracking-packages-with-patient-cases-and-account-credit).
The official API supports case max_sessions, expiry, cancellation/DNA flags and
patient ownership through [patient cases](https://docs.api.cliniko.com/openapi/patient-case/createpatientcase-post),
and accepts patient_case_id when [creating an attendee](https://docs.api.cliniko.com/openapi/attendee/createattendee-post).

This supplies a concrete provider seam for the remaining pass work. It does not
establish a generic membership-balance endpoint or paid entitlement. The next
implementation must preserve exact patient/case ownership, complete linked
attendance counts and current case policy before using a session; cancellation,
move recovery and a full case need explicit verified behavior. No production
case, invoice, credit or payment has been read or written during this research.


## Gap10 full signed and compiled dated movement corrections, E2E-403

Four further complete synthetic journeys pass without production source changes.
Both signed and separately compiled callers correct an unsent move to Saturday
10October, hear a fresh date menu, select the exact new occurrence95 and hear new
fee/recovery consent. Signed callers interrupt the earlier confirmation; the
compiled helper plays its first confirmation before correction. The prior SAM
action stays cancelled. A real minute-scale capacity wait, continuous quiet audio
and normal connected-call lease renewal precede a second affirmative and exactly
one owned movement review, creation/inspection of only the corrected attendance
and cancellation/inspection of the original. Same-service and different instructor,
type and duration paths all pass with unchanged180-request limits and public
model/media plus PostgreSQL privacy scans. No requests or replacement slots are
reserved by waiting, and no proof/offer/effect deadlines are extended.

Exact qualification commands and results:

```sh
bash scripts/with-postgres.sh node --test --test-name-pattern=E2E-403 test/voice/class-move-capacity-call.test.ts
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh node --test --test-name-pattern=E2E-403 test/voice/class-move-capacity-runner.test.ts
node --test test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts
git diff --check
```

Signed2/2 pass in `4590eee3-1792007515424.log` (2m22s tracked); whole-source
typecheck, fresh compiled build and compiled2/2 pass in
`4590eee3-1792007515537.log` (3m43s tracked). No failures, cancellations or skips.
Registry1.211 tracks403 stable scenarios; full-call evidence remains planned.
The existing E2E-402 production source remains the qualified implementation;
this checkpoint extends its concrete date-correction serving evidence and the
synthetic runner fixture. No dependencies or migrations are added.

Membership/pass/credit handling, additional catalogue/operator acceptance and
remaining full13 requirements stay open. Before beginning payments, return to
the earlier incomplete synthetic-speech gap. Its October13 aggregate has source
hashes matching the current transcription implementation and still records12
critical misses across18 noisy runs (40.15% word error rate). Provider credits
were already restored. This is a known quality failure to investigate, not a
new pass or a credit blocker. Real patient audio, real email and Twilio-number
activation remain excluded.


## Return to gap4: current repeated noisy-speech evidence, 14 October2026

The current baseline and two controlled comparisons now have18 results each
(three repeats per pinned noisy case, concurrency2). Current live-transcription
defaults fail with11 critical misses/41.67% WER; near_field reduction has11 misses/
50.76% WER; the committed-turn model has10 misses/30.30% WER. Latency and provider
availability pass their checks; accuracy does not. Every run exits1 for the
unchanged quality gate, not a credential or transport outage. All54 result
identities and current audio/source hashes and assessments were independently
verified. No adapter, model default, threshold, corpus or readiness changed.

See [aggregate metrics and hashes](../eval/baselines/synthetic-speech-comparison-20261014-v1.json)
and [commands, logs and interpretation](../eval/LIVE_BASELINE_2026-09-29.md#current-synthetic-comparison--2026-10-14).
Most remaining model-comparison misses cluster in one synthetic voice. Earlier
October5–8 filter/context/PCMU work already exists; review it and inspect waveform
and conversion evidence before further candidate screens. No fixture defect or
production improvement is claimed. Full speech qualification, remaining class
membership/pass/credits and the full13 objective remain open.


## Gap4 repeated PCMU experiment with repaired outbound capture

The earlier incomplete wire instrumentation is repaired in a new owner-only
runner. Twenty-five offline cases pass, including idempotent close/terminate
capture and rejection of a mismatched format acknowledgment before audio.
All36 measured sessions now have exact expected outbound audio hashes and actual
provider format/model/context acknowledgments. The paired three-repeat comparison
holds model/context/fixture/pacing/concurrency constant. Current PCM has5 critical
misses/28.03% WER; PCMU has4/35.61%. Both fail unchanged accuracy thresholds with
zero provider failures or missing repeats. No candidate is promoted and no
production adapter changes. Locally captured bytes do not prove a remote
receive-byte hash, and this diagnostic shim does not qualify a production binding.

[Metrics, hashes and limitations](../eval/baselines/native-pcmu-repeated-20261014-v1.json)
and [exact commands](../eval/LIVE_BASELINE_2026-09-29.md#repeated-native-pcmu-diagnostic--2026-10-14)
are recorded. Work log `4590eee3-1792008794475.log` exits1 for failed quality;
offline and independent artifact verification exit0. Speech remains on hold.
This closes the diagnostic capture defect, not the full speech or13-gap goal.


## Gap6 approved dated native recurring busy occurrences, E2E-404

The roster reader previously rejected every non-null repeat_rule, including
actual dated busy records. A new optional owner availability-plan value,
`busyRecurrence: nativeOccurrences`, accepts documented metadata on native
individual/group appointments and unavailable blocks. The reader validates the
rule shape but uses only each returned native record's actual start/end instants.
No recurrence dates, count interpretation or DST offsets are generated. Source
business/practitioner identity, active flags, full pagination/adaptive splits,
two stable calendar snapshots and current metadata retain their existing checks.
All-business busy scope and the pre-send source/permission/approval checks remain.
Only the owner file can select this plan; legacy plans and unknown/implicit plan
values deny it. Any recurring extra opening rule remains unsupported.

Native scenarios cover all three busy resource types, independent legacy denial,
malformed metadata, a past root/current child, unstable reads, withdrawal before
send, late busy changes and complete1201-row range splitting. Actual separately
compiled calls use the normal host/contact-revision, SMTP verification, played
menus/confirmation and PostgreSQL request budget. An approved recurring13:00
conflict removes that hour; the caller selects14:00, which is the only new native
appointment. A legacy owner plan offers no partial booking, and a recurring
14:00 conflict introduced after preparation prevents the send. Public/model and
PostgreSQL scans retain private calendar/patient/code canaries.

Initial focused qualification found three incorrect fixture expectations: noon
was outside the daily hours; extra hours start at13:00 (02:00UTC). Correcting that
expected time leaves the native conflict/subtraction assertions intact. Then59
native/calendar checks passed in `4590eee3-1792009518290.log`; whole-source
typecheck, a fresh compiled build and10 compiled current/new calendar journeys
passed in `4590eee3-1792009518444.log`. A later explicit-plan prototype check and
a1201-row recurring-busy scenario are included in final qualification.

See [the approval contract and remaining recurrence limits](LONGER_CLINIKO_AVAILABILITY.md#dated-native-recurring-busy-records-e2e-404).
Registry1.212 tracks404 stable scenarios with full-call evidence still planned.
This is progress in gap6, not full recurrence/clinic acceptance or closure of the
13-gap objective. No dependency, migration, request limit, execution deadline or
production admission changed. Speech remains on hold under its failed gate.


E2E-404 final source qualification: the provider's downloadable OpenAPI schema
(SHA-256 `4c354b3cb3fb9cf7ca91b5dd408b78f62896c62b89d265ba3190e5d2bd03740c`)
confirmed that rule types are Daily/Monthly/Weekly, counts are positive or null,
and intervals are1–100. The new validator/tests were tightened to those bounds;
autogenerated zero-valued page examples do not override schema constraints.
A preceding90-check gate passed before that audit and is not the final-source
claim. The strict final gate in `4590eee3-1792010024558.log` passes whole-source
typecheck, a fresh compiled voice build, isolated migrations and95 affected
native/calendar/approval/online-search/compiled/privacy/registry checks with zero
failures, cancellations or skips, followed by clean diff check. Native large-range,
Daily/Monthly/null-count and boundary-denial cases are included.

Exact executed script (`bash /tmp/abby-e404-final.sh`):

```sh
#!/usr/bin/env bash
set -euo pipefail
cd /home/gust/code/abby-integrated-runner
npm run typecheck
npm run build:voice-tests
bash scripts/with-postgres.sh bash -c '
set -euo pipefail
npm run db:migrate
node --test --test-concurrency=4 \
  test/cliniko/roster-native-repeats.test.ts \
  test/cliniko/roster-booking.test.ts \
  test/cliniko/roster-large-calendar.test.ts \
  test/cliniko/roster-calendar.test.ts \
  test/cliniko/booking-clinic-policy.test.ts \
  test/cliniko/long-booking-search.test.ts \
  test/cliniko/approved-availability-search.test.ts \
  test/voice/compiled-roster-native-repeats.test.ts \
  test/voice/compiled-roster-booking.test.ts \
  test/voice/compiled-roster-coverage.test.ts \
  test/voice/compiled-long-booking-search.test.ts \
  test/contract/scenario-manifest.test.ts \
  test/contract/no-number-gap-trace.test.ts
'
git diff --check
```

This qualification preserves the complete original objective. Recurring extra
opening rules, real source/clinic acceptance, speech accuracy and the remaining
class pass/credit, payment, campaign and approved writeback requirements remain
open; cloud qualification is still required after publication.


## E2E-405 native case session and attendance association boundary

The previous conversational turn answered the owner's architecture question and
made no implementation change; it is classified as no progress toward the
thirteen-gap objective. This turn revalidated clean HEAD bbbe4cb, checked the
tracked work board, and inspected current and archived provider contracts. The
archived availability-block documentation adds no repeat cardinality/month-end/
DST semantics, so recurring extra openings remain open. Independent class-pass
work proceeds without guessing those rules.

`phase-2/CLINIKO_CLASS_PASSES.md` records the current provider sources, accepted
status interpretation and remaining full caller/lifecycle requirements. A new
private native reader counts complete case-linked attendance across services,
requires matching native associations, two snapshots, fresh patient proof and
independent case/class permission, and respects clinic-date and cancelled/DNA
settings. The writer can bind and inspect an exact approved case on one attendee.
No shared group, whole case association list, monetary credit or refund is
changed. Native acceptance alone remains insufficient for caller confirmation.

An initial focused gate found a fixture type mismatch: the case-reader config
type had correctly omitted class writer IDs, but a budget-denial test supplied
it to a writer. The fixture now exposes the original attendance config
separately. No production limit, assertion or failure boundary was relaxed.
The subsequent focused runtime gate passed 100/100 without skips in 2 seconds:
`node --test --test-concurrency=4 test/cliniko/patient-case-sessions.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/class-attendance-read.test.ts`,
tracked as `Abby native case session focused runtime gate`, log
`4590eee3-1792010849861.log`. Final whole-source/compiled and affected host
regression qualification passed 221/221 without failures, cancellations or skips.
Typecheck, a fresh compiled voice build, isolated migrations and diff check also
passed. Tracked job `Abby E405 final type compiled and native class qualification`
completed exit 0 in 2m22s, log `4590eee3-1792010939632.log`.

Exact final commands (also recorded in `/tmp/abby-e405-final.sh`):

```sh
npm run typecheck
npm run build:voice-tests
bash scripts/with-postgres.sh bash -c '
npm run db:migrate && node --test --test-concurrency=4 test/cliniko/patient-case-sessions.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-attendance-move.test.ts test/cliniko/class-move-host.test.ts test/voice/class-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts
'
git diff --check
```

Registry 1.213 tracks 405 scenarios;
E2E-405 is native/text evidence only, with full-call evidence planned.

The next requirements are clinic-owned pass selection and service eligibility,
normal SAM consent and immutable reviewed case association, post-write counter
inspection, cancellation/move consumption/recovery, and actual compiled caller
journeys. Financial account credit/payment remains gap 11. The full thirteen
gaps and actual clinic/mail/acoustic/carrier/cloud acceptance stay open.


## E2E-406 approved pass booking through the ordinary caller host

The previous goal turn is progress: it published the E405 native boundary at
420eadd with 221 locally qualified checks. This turn revalidated that clean
head and the work board before extending the actual booking host, class
session, service catalogue and ordinary call-flow composition.

A native case-session approval now explicitly accepts status, count, date and
one-attendance consumption contracts while keeping financial authority in an
independent host. An exact case/entitlement selection is bound to the private
offer and prepared SAM action. Selection or source changes cannot silently
choose another pass. The normal played approved terms and separate affirmative
precede a versioned native class review containing that exact binding. Both
attendee inspection and whole-case one-addition inspection are required for
confirmation, including when the last available session was consumed. A
concurrent association swap cannot hide behind the same net count.

Native pass cancellation and movement remain unimplemented; their session and
direct-host constructors require the legacy independent mode until their own
consumption/release workflow exists. The new approval does not implicitly
activate those operations. Actual financial/service entitlement provisioning,
clinic acceptance and monetary account credit remain separate open work.

The first focused native/host gate passed 82 checks. A later type gate found
two test fixture errors: explicit undefined on an exact optional owner field,
and a review fixture spreading an unnarrowed operation union. The invalid
owner document is now written as invalid input directly, and the known class
operation is narrowed before constructing the review test. Whole-source
typecheck and fresh compiled build then passed in tracked job
`Abby E406 corrected fixture types and compiled pass runner build`, exit0,
1m18s, log `4590eee3-1792011728891.log`. No assertion, budget, deadline or
production approval rule was relaxed. Final compiled and affected regressions are recorded below.

Registry 1.214 tracks 406 stable scenarios. E406 full-call evidence remains
planned. The full thirteen-gap objective and all earlier real acceptance,
noisy speech, recurring extra-opening and cloud limitations remain open.


The initial compiled pass gate completed 43/44, with the single positive
confirmation failing after exhausting the actual 180-request PostgreSQL budget
during final inspection (log `4590eee3-1792011825090.log`). The production fix
adds guarded advisory capacity checks for native pass booking and extends the
existing core wait transition to an independently approved booking action,
retaining played consent, current evidence and a later clear affirmative.
There is no quota increase, implicit reservation or delayed automatic dispatch.
An intermediate source gate then found that the core transition was still
move-only (`confirmationMissing`); the booking branch and truthful unbooked
wording now have the same policy/evidence guards. Native pass, legacy booking
and existing movement-capacity regression passed after that change in tracked
job `Abby E406 booking capacity state and native pass qualification`, exit0,
log `4590eee3-1792012187533.log`. The final source gate below includes pending
capacity abort/correction/permission cases and the complete real-wait compiled
pass journeys.


### E406 final source qualification

The final frozen source passed whole-source typecheck, a fresh compiled voice
build, isolated PostgreSQL migrations, 298/298 affected native/host/session/
compiled/registry checks and diff checks, with no failures, cancellations or
skips. Tracked job `Abby E406 final pass caller and capacity qualification`
completed exit0 in 4m17s, log `4590eee3-1792012243302.log`.

The six compiled pass cases all passed, including last-session success under
the actual 180-request account limit, changed/denied authority, depletion,
lost acknowledgement and concurrent use. Real quota waits preserve the
original prepared action without dispatch, keep normal call leases alive with
quiet media, and require another affirmative. Public/model and PostgreSQL
scans include the private pass case ID, entitlement, clinical canaries and code.
The 16 existing compiled class booking/cancellation journeys also passed.

Exact final commands, also retained in `/tmp/abby-e406-final.sh`:

```sh
npm run typecheck
npm run build:voice-tests
bash scripts/with-postgres.sh bash -c '
npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-pass-booking-host.test.ts test/cliniko/patient-case-sessions.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-session.test.ts test/cliniko/class-attendance-move.test.ts test/cliniko/class-move-host.test.ts test/cliniko/class-move-capacity.test.ts test/cliniko/class-review-context.test.ts test/voice/class-pass-runner.test.ts test/voice/class-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts
'
git diff --check
```

This is locally qualified ordinary pass booking, not closure of all pass
lifecycle or gap10 work. Native pass cancellation/movement, financial/service
authority provisioning, account credit/payment and actual acceptance remain
open. Account headroom is advisory; concurrent late consumers can still make a
sent outcome uncertain, which must not replay. No production admission, carrier,
mailbox, speech threshold, dependency, request limit or migration was changed.


## E2E-407 native pass cancellation through the ordinary caller

The previous goal turn made progress: fd6d102 published ordinary native pass
booking with 298 locally qualified checks and preserved the actual 180-request
limit. This turn revalidated that clean source and the shared work board, then
extended cancellation without treating it as a payment refund.

The native case reader now inspects the exact existing own active attendance
and its real contribution under DNA rules. A cancellation can release one
counted session, preserve usage, or consume a previously excluded DNA session
when cancelled records count. An explicit owner cancellation contract supplies
versioned approved text for all three effects. Independent authority first
permits private association inspection and must then approve the actual effect
for the same exact attendance/case/entitlement before proposal and send.

The core wait protocol now supports an independently permitted cancellation
action, with cancellation-specific capability/evidence checks and truthful
uncancelled wording. No earlier affirmative becomes a delayed send. All
provider requests still claim the unchanged account budget. The prepared
private case/effect is bound to normal played fee/pass terms and a distinct
versioned cancellation-pass review. After one native cancellation the reader
normalizes only that attendee's cancelled state and requires the entire prior
case state to match, plus the exact expected counter delta. A same-net swap
cannot hide another use. Closed, expired and full passes can lose attendance
without changing case validity, maximum or money.

The focused native/host gate passed 134/134 without failure or skip in 16s,
tracked job `Abby E407 native pass cancellation host proof`, log
`4590eee3-1792013172978.log`. Source typecheck and fresh compiled build passed
in 1m17s, tracked job `Abby E407 cancellation typecheck and fresh runner build`,
log `4590eee3-1792013253795.log`. Additional pending-capacity, malformed-owner
and review-loss cases are included in final regression qualification.
The compiled eight-case and final frozen-source results are recorded below.

Registry 1.215 tracks 407 stable scenarios; full-call evidence remains planned.
Native pass movement, broader and mixed catalogue/correction combinations,
actual independent entitlement provisioning and financial gap11 remain open.
Recurring extra openings, noisy speech, delivery/clinic/operator acceptance
and exact-head cloud startup limitations remain separate unfinished work. The
full thirteen-gap objective remains active.


The complete compiled cancellation/effect gate passed 14/14 (eight actual
compiled caller journeys plus six review-context checks), zero failures,
cancellations or skips. Tracked job `Abby E407 compiled pass cancellation
journeys` completed exit0 in 3m38s, log `4590eee3-1792013372732.log`.
All release/unchanged/consume outcomes and denied/changed/rule/lost/race cases
retained real database quota waits, ordinary lease renewal, a new affirmative
and the actual 180-request limit. No budget, deadline, assertion or provider
post-inspection was relaxed. The final frozen-source regression also covers
additional DNA status, pending-capacity and malformed owner cases.


### E407 final source qualification

Final frozen source passed whole-source typecheck, a fresh compiled voice
build, isolated PostgreSQL migrations, 391/391 affected native/host/session/
service/movement/compiled/registry checks and diff checks. There were zero
failures, cancellations or skips. Tracked job `Abby E407 final pass cancellation
and lifecycle qualification` completed exit0 in 5m31s, log
`4590eee3-1792013663745.log`. The run includes eight complete compiled pass
cancellations, six compiled pass bookings and sixteen existing compiled class
booking/cancellation journeys, with actual 180-request limits, real quota
windows, normal call leases, new affirmative consent and privacy scans.

Exact commands, also retained in `/tmp/abby-e407-final.sh`:

```sh
npm run typecheck
npm run build:voice-tests
bash scripts/with-postgres.sh bash -c '
npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-pass-cancellation-host.test.ts test/cliniko/class-pass-booking-host.test.ts test/cliniko/patient-case-sessions.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-session.test.ts test/cliniko/class-service-selection.test.ts test/cliniko/class-move-session.test.ts test/cliniko/class-attendance-move.test.ts test/cliniko/class-move-host.test.ts test/cliniko/class-move-capacity.test.ts test/cliniko/class-review-context.test.ts test/voice/class-pass-cancellation-runner.test.ts test/voice/class-pass-runner.test.ts test/voice/class-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts
'
git diff --check
```

This locally qualifies the explicit native pass cancellation protocol. Native
pass movement, larger histories under the whole caller quota protocol, mixed
case/cash and broader catalogue/correction coverage remain open, as do actual
independent entitlement provisioning and clinic/provider/operator acceptance.
No financial account credit or refund operation is implemented by cancellation.
No dependency, migration, request limit, deadline, speech threshold, production
admission, real patient data, mailbox or Twilio number was changed. The full
thirteen-gap objective remains active.


## E2E-408 native pass movement prerequisites

The provider attendee update accepts a case association but does not document
changing the attendance's booking or patient. Added a guarded `linkCase` operation
that changes only `patient_case_id` for one exact Abby-created replacement,
requires its distinct creation marker and validates acknowledgement/readback.
Unknown, wrong or lost responses cannot replay or become caller success.

Added complete case-state movement inspection: exactly the original cancellation
and active destination replacement may differ from the previous fingerprint.
Cancellation/DNA effects, full passes, wrong occurrences, metadata drift,
concurrent use and equal-net association swaps are covered. No native counter
supplies money, consent or capacity reservation authority.

Further primary-source investigation established a staging proof: Cliniko's
numeric `!?` operator and supported attendee `patient_case_id` filter allow two
exact, protected null-case queries for the replacement. An omitted case response
property alone cannot pass; auto-association, source changes, positive-link
contradictions and incomplete filtered responses deny. Every observation uses
normal shared budget claims and current independent permission. This removes
the response-shape uncertainty; host staging/recovery authority and the complete
caller move still need implementation. Native pass movement remains disabled
in the serving host until its consent, review, coordinator and compiled journeys
are complete. All thirteen requirements retain their scope.

Validation:

- `npm run typecheck && npm run build:voice-tests`: passed in both final tracked
  stages, with the final stage including the new filtered staging method.
- `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-pass-cancellation-host.test.ts test/cliniko/class-pass-booking-host.test.ts test/cliniko/patient-case-sessions.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/class-attendance-case-write.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-session.test.ts test/cliniko/class-service-selection.test.ts test/cliniko/class-move-session.test.ts test/cliniko/class-attendance-move.test.ts test/cliniko/class-move-host.test.ts test/cliniko/class-move-capacity.test.ts test/cliniko/class-review-context.test.ts test/voice/class-pass-cancellation-runner.test.ts test/voice/class-pass-runner.test.ts test/voice/class-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts'`: **440 passed**, zero failures/cancellations/skips. Tracked job
  `Abby E408 final native pass movement primitives and caller regression`,
  exit0,5m45s; log `4590eee3-1792014814093.log`. This stage preceded the added
  unlinked-read method; existing caller write/inspection paths were unchanged.
- Final current-source `node --test --test-concurrency=4 test/cliniko/class-attendance-staging.test.ts test/cliniko/class-attendance-case-write.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/patient-case-sessions.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts`:
  **136 passed**, zero failures/cancellations/skips, after fresh whole-source
  typecheck and compiled voice build. Tracked job
  `Abby E408 final staging type build and native qualification`, exit0,1m36s;
  log `4590eee3-1792015183428.log`. Counts overlap the earlier stage and are not
  a claim of additional full caller journeys.
- `git diff --check`: passed. Manifest1.216 has408 stable scenarios; E408 is
  private adapter/text evidence only and full-call evidence remains planned.

The first type gate caught a fixture inferred as arrival-null only; it now uses
an explicit native record type so the DNA drift case typechecks. The initial
staging proof-count assertion observed a spread getter's old value; the fixture
now delegates to the actual proof counter and the unchanged four-check assertion
passes. Neither correction relaxed runtime rules, limits or assertions.

Remaining work: compose replacement-first unlinked staging, original cancellation
and final case association under explicit host authority, reviewed played
consent and truthful recovery; qualify full and cross-case/service caller moves,
larger case histories under whole-call quota, mixed catalogues and all remaining
financial/campaign/document and actual acceptance requirements. Cloud validation
is not implied by local evidence.


## E2E-409 native pass movement coordinator

Added independent source/destination pass selection and actual-effect authority,
then composed the existing movement coordinator with explicit unlinked staging,
original cancellation, destination association and complete case inspection.
Full passes can reuse released sessions; retained/increased source usage requires
available approved capacity. Same/cross-case and same/cross-service/instructor/
duration paths are covered, including an expired/closed source transferring to a
valid destination. No money, refund or reservation authority is inferred.

Compensation is restricted to an original cancellation never sent. It rechecks
both cases and proves the exact cancelled replacement remains unlinked with a
native wildcard inclusion query. Unknown review/creation/cancellation/link or
compensation replies stay uncertain and cannot replay or trigger unsafe rollback.
Distinct leg markers and explicit case-association state support staff recovery.

The first cross-service pipeline exhausted the unchanged180-request budget.
The corrected native flow journals confirmed proposed context under current
proof and independent permissions, then checks complete live class/case state
immediately before creation. Complete source-case cancellation proof replaces
redundant post-cancellation source rosters; destination capacity and exact final
whole-case effects are still fresh. Legacy movement retains its existing paired
roster checks. No account limit, timeout, assertion or relevant evidence check
was relaxed. Small-case native transactions now qualify under the original
physical budget; larger histories through whole callers remain unqualified.

A new private movement review preserves both case/entitlement/fingerprint/count
bindings, expected effect and staging version. A realistic identifier-width
probe found an uncompressed tuple could not fit the unchanged1000-character
summary limit (1092 payload characters in that probe). The final protocol uses a
versioned lossless compressed tuple, bounded encoding/inflation, strict UTF-8,
canonical base64url, exact tuple lengths and named-context validation. Full-width
19-digit identifiers with ordinary UUID references round-trip without truncation
or replacing context with a hash. Legacy review wire formats stay unchanged.

The initial native fixture accidentally intercepted ordinary class-roster
attendee queries as staging queries; routing now distinguishes the exact native
is-null predicate. The unchanged positive tests then exposed the real quota
failure, which was fixed by the evidence-boundary changes above. Invalid legacy
configuration is now tested by actually omitting the native port, separately
from rejecting an explicitly undefined native configuration. Oversized review
coverage uses high-entropy context, and the encoder rejects payloads exceeding
the decoder's uncompressed bound. These are real bounds and contract assertions,
not relaxed gates.

Validation:

- Before lossless compression, type/build/migrations and505 native, host,
  signed/compiled caller and registry checks passed, zero failures/skips; tracked
  log `4590eee3-1792016293424.log`, exit0,5m28s. This is intermediate evidence.
- The realistic-width diagnostic log `4590eee3-1792016679769.log` demonstrated
  the old tuple rejection and measured833 summary characters after lossless
  encoding of its complete representative context. Committed tests additionally
  use19-digit native identifiers.
- After compression,134 focused native/review checks passed, zero failures/skips,
  log `4590eee3-1792016780509.log`.
- Full regression: whole-source typecheck, fresh compiled build, isolated
  PostgreSQL migrations and **507 checks passed**, zero failures/cancellations/
  skips; diff check passed. Tracked job
  `Abby E409 final bounded review and complete class regression`, exit0,5m36s;
  log `4590eee3-1792016818592.log`.
- Final current-source encoder-bound and staff-review qualification: fresh
  whole-source typecheck/build/migrations plus **164 checks passed**, zero
  failures/cancellations/skips; diff check passed. Tracked job
  `Abby E409 final encoder bound and staff review qualification`, exit0,1m18s;
  log `4590eee3-1792017189184.log`. This rebuild includes the final encoder/decoder
  byte-bound parity check. Counts overlap and are not summed.

Exact full regression script:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm run typecheck
npm run build:voice-tests
bash scripts/with-postgres.sh bash -c '
npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-pass-cancellation-host.test.ts test/cliniko/class-pass-booking-host.test.ts test/cliniko/patient-case-sessions.test.ts test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/class-attendance-case-write.test.ts test/cliniko/class-attendance-staging.test.ts test/cliniko/class-pass-movement.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-cancellation-host.test.ts test/cliniko/class-session.test.ts test/cliniko/class-service-selection.test.ts test/cliniko/class-move-session.test.ts test/cliniko/class-attendance-move.test.ts test/cliniko/class-move-host.test.ts test/cliniko/class-move-capacity.test.ts test/cliniko/class-review-context.test.ts test/voice/class-pass-cancellation-runner.test.ts test/voice/class-pass-runner.test.ts test/voice/class-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts
'
git diff --check
```

Exact final current-source review gate:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm run typecheck
npm run build:voice-tests
bash scripts/with-postgres.sh bash -c '
npm run db:migrate && node --test --test-concurrency=4 test/cliniko/class-pass-movement.test.ts test/cliniko/class-attendance-move.test.ts test/cliniko/class-review-context.test.ts test/cliniko/class-attendance-staging.test.ts test/cliniko/class-attendance-case-write.test.ts test/cliniko/reviewed-send.test.ts test/cliniko/recalls.test.ts test/cliniko/review-discovery.test.ts test/cliniko/cancellation-review-context.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts
'
git diff --check
```

Manifest1.217 tracks409 stable scenarios. E409 is native adapter/coordinator
text evidence only; it adds no ordinary caller pass-move journey or full-call
qualification. The serving host still rejects native pass movement until the
owner-approved staging/effect/recovery terms, private offer binding, played
consent, owned action/review and signed/compiled journeys are implemented.
Larger/mixed histories and catalogue/correction coverage, independent financial
provisioning, actual clinic/operator/cloud/mail/acoustic/carrier acceptance and
all remaining financial/campaign/document requirements remain open. The full
thirteen-gap objective stays active.


## E410 ordinary native pass movement: caller and serving qualification

The previous implementation goal turn supplied E409 native coordinator and
review evidence. The intervening explanatory answer added no implementation.
This turn makes concrete progress with explicit owner-approved native pass
movement terms, current private offer bindings, admitted class owner/catalogue
routing, played SAM consent, truthful quota waits and compiled serving fixtures.
The full thirteen-gap objective remains unchanged and incomplete.

Six approved effect texts distinguish unchanged, one or two extra sessions on
the same case and release/unchanged/consume on the source of a cross-case move.
The destination and exact independent entitlement are pinned privately to each
offer. The actual SAM terms digest binds that private evidence; no case IDs or
fingerprints enter public text. Missing contracts, incomplete authority ports
or mixed source/destination/movement modes prevent admission and code delivery.

One private compound GET observation verifies the actual operation proof and
native contact before and after all of its reads. Its scoped proof closes
before returning; revocation discards the entire observation. Native source,
complete snapshot, rule and permission checks remain inside each reader.
Clinical writes and protected result publication are outside the callback;
financial permission is fresh after closure. No proof cache crosses a write.
The physical180 account budget, native deadlines and normal connected-call
leases remain unchanged. Waiting for a fresh window requires played guidance,
ordinary elapsed time and another affirmative before any reviewed dispatch.

Initial checks passed89 caller/native/proof tests, log
`4590eee3-1792018612885.log`. The subsequent source type/build and14 admission
checks passed, log `4590eee3-1792018751279.log`. A wider native/host/service/
legacy/review regression passed279 checks with zero failures, cancellations or
skips, log `4590eee3-1792018931481.log`.

The first compiled run completed all7 tests with2 passing and5 failing, log
`4590eee3-1792018840210.log`. Four failures occurred after the native transaction
and truthful outcome assertions because the new privacy test supplied an
encoded review longer than the existing256-character diagnostic input limit.
The test now scans every payload fragment within the existing limit and batches
all fragments under the existing12-canary limit, while retaining full public
payload checks. The fifth failure incorrectly expected zero review journals
when a case rule changed. The owned journal records the played proposal before
fresh clinical observation; the native check correctly stopped all attendance
writes. The corrected test asserts exactly one owned recall and zero clinical
mutations for this case. Authority/selection denial still requires zero records.
No production scanner, limit, assertion about clinical effects, deadline or
permission requirement was weakened. Earlier type diagnostics were incorrect
review field names and an optional test-port cast; both were corrected.

Final current-source type/build/migration and compiled movement/pass regression
passed40 checks with zero failures, cancellations or skips. Tracked job
`Abby E410 final compiled movement and pass regression` completed exit0 in5m25s,
log `4590eee3-1792019068783.log`. This includes all7 E410 journeys, existing
ordinary movement/recovery and native pass booking/cancellation. Registry1.218
tracks410 scenarios; E410 has text and synthetic serving evidence, with
full-call evidence still planned. The native279 and final40 counts overlap
in the two registry/trace checks.
Larger/mixed histories, broader catalogue/correction combinations, financial
provisioning, actual clinic/cloud/speech/mail/carrier acceptance and the remaining
financial/campaign/document requirements stay open.

Exact final current-source command:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm run typecheck
npm run build:voice-tests
bash scripts/with-postgres.sh bash -c '
npm run db:migrate && node --test --test-concurrency=4 test/voice/class-pass-move-runner.test.ts test/voice/class-move-runner.test.ts test/voice/class-pass-runner.test.ts test/voice/class-pass-cancellation-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts
'
git diff --check
```


## E411 complete mixed pass histories and native request cost

The previous goal turn is progress: E410 was published as
c7018ee53a671f32d908acab354bbd2ecf604c62 with279 native and40 compiled/contract
checks passing. This turn inspected that current clean worktree and confirmed
no own qualification job was live before starting the next investigation.
The full thirteen-gap objective remains active and unchanged.

An actual ordinary-SAM baseline varied mixed case histories across10,101,301
and1000 linked associations. Same-case301 and cross-case101 could send all
three native changes but then exhaust the physical180-request window before
complete final inspection. Outcomes correctly remained uncertain; this is
incomplete capability rather than completed movement. Baseline log:
`4590eee3-1792019613718.log`. The source-level native proof fixture alone was
insufficient to expose the real caller's native-contact request costs.

The coordinator consolidates replacement/staging and current source/destination
observations after the cancellation writer's budget claim. Unlinked proof already
checks the exact active record, patient, booking and creation marker twice.
Complete source-case observations now additionally require the exact approved
cancellation reason before association and in final movement inspection; no
separate original-attendee GET is required. Final destination association/marker
inspection remains mandatory. Real proof and financial checks close before any
write, and original-not-sent compensation retains its current independent checks.

Strict native class reads previously fetched metadata before both roster
snapshots and afterward. The second snapshot now reads metadata after its roster;
metadata brackets both complete snapshots with no middle duplicate. The original
negative drift tests were scheduled on the old second metadata fetch, which now
occurs after the two rosters. Their mutations now occur on the second actual
class snapshot, retaining every denial assertion. An explicit before/after
ordering assertion replaces the old three-fetch-count assertion. The final-roster
metadata-revocation negative remains unchanged and passes. No runtime gate,
deadline, quota, caller consent or protected-read requirement was relaxed.

The private case result now distinguishes associationCount from used sessions.
Native additions that would exceed the existing1000-record complete-inspection
limit cannot yield a selectable offer, even if the pass has remaining sessions.
The normalized counter fingerprint and existing review wire format are preserved;
raw reasons and notes do not enter the result. Wrong/missing/string cancellation
reasons, same-count last-page association changes and in-group permission loss
cannot confirm or replay. A new cancellation test initially referred to a record
on an unrelated booking; its fixture now puts that exact attendee on the approved
query booking before observing the baseline, retaining all reason assertions.

Qualification chronology:

- First coordinator consolidation:123 checks passed, log
  `4590eee3-1792019854050.log`.
- Exact reason/count boundary regression:168 checks passed, log
  `4590eee3-1792020087550.log`.
- First history fixture run:146/147 passed; the single fixture booking mismatch
  described above failed, log `4590eee3-1792020179682.log`.
- First reordered-metadata gate:222/225 passed; the old metadata ordinal and
  drift scheduling described above failed, log `4590eee3-1792020304055.log`.
- Correct current native/owner/read/booking/cancellation gate:225 passed, zero
  failures/cancellations/skips, log `4590eee3-1792020438397.log`. This includes
  ordinary501 same-case and201 cross-case/service/instructor/duration movements
  under the unchanged180 physical limit.
- Current typecheck and compiled runner build passed, log
  `4590eee3-1792020496786.log`, elapsed1m10s.

Actual compiled E411 and affected legacy/native class serving qualification is
running as `Abby E411 frozen compiled multi page and full affected class serving
regression`, log `4590eee3-1792020584691.log`. Registry1.219 tracks411 scenarios;
E411 remains text evidence until that serving gate passes. Larger history cost
admission and staged quota handling remain unfinished; the probe still finds
some larger cross-case workloads unconfirmed after exhausted-budget inspection.
All remaining catalogue/correction/financial provisioning, production acceptance
and payment/campaign/document requirements remain open.


### E411 native-state defaults and stronger recovery evidence

The first compiled serving gate completed59 checks with58 passing, zero skips,
log `4590eee3-1792020584691.log`. All three E411 large-history journeys passed.
The sole failure was an older capacity-race recovery test that expected budget
exhaustion at180. With fewer metadata requests it now completed all recovery
inspection at167 requests and correctly returned a restored/rejected move.
The test now requires that positive recovery and retains a separate exhausted
negative using normal claims by simulated competing account consumers after
compensation was sent. No budget rows, limits, clocks or leases are altered.

The rebuilt60-check serving gate passed with zero failures/cancellations/skips,
log `4590eee3-1792020909355.log`, elapsed5m03s. This includes the explicit
competing-budget negative and the verified positive recovery. That build predates
the state-inclusion follow-up below, so it does not qualify that later change.

Primary API review confirmed supported DateTime wildcard inclusion and the
case/attendee endpoint filter fields. Cliniko's introduction documents that some
endpoints exclude inactive records by default; we do not assume a particular
case endpoint always includes them. See
[filtering results](https://docs.api.cliniko.com/#filtering-results),
[Attendee API](https://docs.api.cliniko.com/openapi/attendee/listattendees-get) and
[Patient Case API](https://docs.api.cliniko.com/openapi/patient-case/listpatientcases-get).
The locally inspected official OpenAPI description is the October14 snapshot
SHA2564c354b3cb3fb9cf7ca91b5dd408b78f62896c62b89d265ba3190e5d2bd03740c.
The case-attendee route supports all three state filters; the case metadata GET
supports archived_at. No production API or patient data was accessed.

A new native-default test reproduced incomplete history:77/78 checks passed and
the new desired complete-state result failed, log
`4590eee3-1792021007014.log`. The reader now requests archived/cancelled/deleted
states explicitly on every case collection, and archived case metadata explicitly.
Exact attendee inspection uses the same inclusion wildcards while retaining all
receipt and active/deleted/archived-state validation. Fixtures independently
model hidden states and reject unwanted date/service narrowing. The old counter
fingerprint encoding is unchanged.

Current explicit-state native regression passed280 checks with zero failures,
cancellations or skips, log `4590eee3-1792021108065.log`. The new exact-attendee
fixture initially delegated to its base reader-only fetch port; correcting it to
return its owned writer-aware port made all134 focused exact-record/metadata/case
checks pass, log `4590eee3-1792021310298.log`. The earlier failed fixture run is
retained as `4590eee3-1792021239443.log`. Current production/source typecheck
passed, log `4590eee3-1792021152189.log`; the final full-source type gate follows
all test-fixture/evidence updates before publication.

Final rebuilt state-including serving qualification passed60 checks with zero
failures/cancellations/skips. Tracked job
`Abby E411 final full state included serving qualification` completed exit0 in
4m52s, log `4590eee3-1792021310745.log`. This includes all three E411 larger
history/last-page journeys, legacy/native class booking/cancellation/movement,
verified capacity recovery and explicit competing-budget uncertainty. Final
full-source typechecking and post-evidence registry checks precede publication. Broader history cost
admission and staged quota handling remain open; these successful workload sizes
do not close the complete thirteen-gap objective.

Exact final state-including serving command:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm run build:voice-tests
bash scripts/with-postgres.sh bash -c '
npm run db:migrate && node --test --test-concurrency=4 test/voice/class-pass-history-runner.test.ts test/voice/class-pass-move-runner.test.ts test/voice/class-move-runner.test.ts test/voice/class-runner.test.ts test/voice/class-pass-runner.test.ts test/voice/class-pass-cancellation-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts
'
git diff --check
```


Final current-source type/evidence gate passed: full `npm run typecheck`, both
post-promotion registry/trace checks and `git diff --check`, tracked job
`Abby E411 final full source and evidence registry gate`, exit0 in46s,
log `4590eee3-1792021678811.log`. The final native280, focused134 and compiled60
counts overlap; none represents full-call, cloud or clinic acceptance. E411 is
syntheticImplemented in registry1.219 /411. Broader cost admission/staged quota,
remaining catalogue/correction/financial provisioning, and all remaining full13
requirements stay open.


## E412 paired case observations and known-workload admission

Previous conversational turn was no progress toward implementation. Current
source revalidated at publishedf0825f1 with two pending paired-reader files;
tracked predecessor148-check native job completed exit0. No old process was
restarted on an observation timeout. No other agent work or data was removed.

Same-case movement now uses one complete snapshot pair for its two targets.
Both target permissions and proofs are checked independently before and after
all native observations; source and destination date eligibility is evaluated
separately. Same-count association/booking drift and exact wrong cancellation
reasons still deny. Different cases retain independent complete observations.
The1000-association inspection bound,180 physical requests per minute,15s
reader/writer limits and30s movement deadline remain unchanged.

A private current workload lower bound includes every complete case page and
its added destination association, the mandatory class reads, journal, native
writes, staging and final exact receipt. The bound excludes unknown extra
metadata/roster pagination and custom permission/proof I/O. The ordinary host
adds nine contact reads only for a verifier bound to the same Cliniko account.
A known minimum above180 cannot yield an ordinary proposal. The native
coordinator repeats the check in its current protected observation before any
replacement send. Every provider request still claims normally; this is neither
complete admission nor a reservation, staged movement or a recovery guarantee.

Measured generic-proof native success claims match the bound at99,100,201 and999
associations across same/different services and cases. Native contact proof
makes a301-association cross-case/different-service transfer need at least182
requests; its ordinary path now yields no offer, journal or clinical mutation.
A999-association same-case/service move uses170 including native contact proof,
retains played terms and fresh affirmation after the normal quota wait, and
inspects all1000 final associations.

Intermediate qualification:

- Source typecheck passed in tracked `Abby E412 current source typecheck`,
  log `4590eee3-1792022377001.log`.
- First paired boundary/history regression passed162/163, log
  `4590eee3-1792022407815.log`. The new test helper spread captured a proof counter
  getter at zero; forwarding the getter fixed the assertion. Focused case-reader
  correction passed, log `4590eee3-1792022465482.log`. No source gate was relaxed.
- Workload regression passed168/170, log `4590eee3-1792022541203.log`:
  two new tests treated callerMessages strings as objects. After correcting that,
  full source typecheck passed but the same two assertions expected booking wording
  rather than actual rescheduling wording, log `4590eee3-1792022582168.log`.
  Both now require the existing eligible-new-appointment wording. No production
  wording, mutation assertion or denial behavior changed.
- Corrected current native gate passed170 checks, zero failures/cancellations/skips,
  as the first stage of tracked `Abby E412 corrected no offer native and compiled
  qualification`, log `4590eee3-1792022668501.log`. Exact command:
  `node --test --test-concurrency=4 test/cliniko/patient-case-sessions.test.ts test/cliniko/class-pass-movement.test.ts test/cliniko/class-pass-history.test.ts test/cliniko/class-pass-move-host.test.ts`.
- That same job is now rebuilding the actual voice runner, then runs isolated
  PostgreSQL migrations and all affected compiled class/pass/legacy movement,
  booking/cancellation and contract checks. Registry1.220/412 currently marks
  E412 textImplemented; compiled evidence is pending and full-call stays planned.

All thirteen requirements remain active. Full observed-cost admission, concurrent
quota/recovery ownership and staged moves that need more than one window remain
unfinished, alongside mixed catalogue/correction qualification, independent
financial provisioning, payment lifecycle, campaigns and document writeback.
Actual speech gates still fail; real sender, recipient, clinic, cloud and carrier
acceptance are absent. No patient traffic, production account or real financial
operation was used.


### E412 rebuilt serving result

Tracked `Abby E412 corrected no offer native and compiled qualification`
completed exit0 in5m21s, log `4590eee3-1792022668501.log`. The native170-check
stage and subsequent actual compiled62-check stage have zero failures,
cancellations or skips. Compiled build and isolated PostgreSQL migrations passed.
The999-record same-case/service move confirms only after played consent, a normal
quota wait and a fresh affirmative; its final case has1000 linked records.
The301-record cross-case/different-service path offers no proposal, creates no
journal/clinical mutation and cannot turn an unbound Yes into a write. Private
canaries remain absent from public voice/model and PostgreSQL core storage.
Existing501/201 movements, last-page drift, loss/no replay, capacity-race recovery
and explicit competing-account quota exhaustion remain covered.

Compiled command after `npm run build:voice-tests`:
`bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/voice/class-pass-history-runner.test.ts test/voice/class-pass-move-runner.test.ts test/voice/class-move-runner.test.ts test/voice/class-runner.test.ts test/voice/class-pass-runner.test.ts test/voice/class-pass-cancellation-runner.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts'`.

Registry1.220/412 now marks E412 syntheticImplemented. Full-call evidence remains
planned. These are synthetic provider/media/SMTP fixtures; acoustic, actual
carrier, live clinic, human recipient and authoritative cloud acceptance remain
absent. Complete observed-cost admission, reservations and staged quota/recovery
remain unfinished. The thirteen-gap objective remains active and unchanged.


Final current-source evidence gate `Abby E412 final source registry and evidence
gate` completed exit0 in52s, log `4590eee3-1792023021380.log`:
`npm run typecheck`, both scenario-manifest/no-number-gap-trace checks and
`git diff --check` passed, zero failures/skips. Counts overlap prior contracts.
Publication updates draft457; exact published-head cloud checks require fresh
inspection. No old head or local result is substituted for cloud qualification.


## E413 class verification credential boundary

E412 published at5f07e26cb52895753ac3ce016b648d0759f915c9 in draft457.
Its exact-head PR/push jobs were inspected in `4590eee3-1792023099365.log`:
all eight jobs stopped with zero steps because GitHub account payments/spending
limits prevented startup. Publication/audit recording passed in
`4590eee3-1792023124190.log`. This is not cloud qualification or a reason to
stop independent engineering. The full thirteen-gap scope remains active.

While continuing workload ownership, source inspection showed that class
factories checked the exact call proof and target native approvals but did not
require that the verifier's registered contact belonged to the same Cliniko
credential. A synthetic reproduction with the same call, independently current
other-credential target approvals and overlapping native IDs constructed the
move host and read one protected class. Tracked diagnostic
`Abby E413 reproduce class verifier account boundary` passed as a reproduction,
log `4590eee3-1792023173516.log`. The patient-free baseline is
`eval/baselines/class-verification-account-before-v1.json`; it records only
source commit, booleans and one count, not any raw credential, contact or patient.

Three independent regression cases first failed0/3 on the intended acceptance
assertion, not malformed policy setup, in `4590eee3-1792023245737.log`.
All three now pass in `4590eee3-1792023263219.log` after requiring
`CallerVerificationSession.matchesClinikoAccount` in booking, cancellation and
movement factories. The existing check binds the actual native registered
contact to credential fingerprint and tenant/clinic; exact call/session/policy
scope is still independently required. No provider read, recall or clinical
mutation may occur on mismatch. This repairs part of gaps2 and10, not general
representative or financial authority.

Current full source typecheck, affected native class/pass hosts and actual
compiled serving regression are running in tracked
`Abby E413 account binding type native and compiled qualification`, log
`4590eee3-1792023288134.log`. Registry1.221/413 records E413 textImplemented;
full-call remains planned. Matching-account compiled acceptance is not inferred
from the new negative unit cases. Larger staged quota/recovery, complete cost
admission, catalogue/corrections, financial provisioning, payments, campaigns and
document writeback remain unfinished, along with actual clinic/speech/mail/cloud
and deferred carrier acceptance.


### E413 matching-account regression result

Tracked `Abby E413 account binding type native and compiled qualification`
completed exit0 in6m39s, log `4590eee3-1792023288134.log`. Whole-source typecheck,
178 affected native tests, rebuilt voice runner, isolated PostgreSQL migrations,
62 compiled/contract tests and diff check passed with zero failures/cancellations/
skips. The native command covers `class-verification-account`, `class-booking-host`,
`class-cancellation-host`, `class-move-host`, all three `class-pass-*-host` files
and `class-pass-history` at concurrency4. The subsequent compiled command is the
same eight-file build/migration/serving/contract gate recorded under E412 above.

Matching-account normal class/pass calls,999/501/201 histories, played terms,
quota waits, exact native results, changed permission/policy, lost receipts,
concurrent case changes and guarded recovery remain covered. E413 itself stays
textImplemented at1.221/413: existing matching-account compiled calls do not
substitute for a new cross-account carrier scenario. Full-call evidence stays
planned. Exact current evidence/type/registry/diff checks precede publication.

Next reassessment follows the original order: gaps2/3 still lack actual sender,
recipient/clinic operating acceptance; the earliest remaining engineering failure
is gap4's synthetic speech quality. No model/acoustic candidate currently passes.
Continue that investigation with patient-free synthetic audio as requested, while
retaining the unfinished class cost/reservation/staging work under gap10 and the
remaining catalogue/correction/financial/payment/campaign/document requirements.
No production or carrier readiness is inferred from this regression.


Final E413 current-source gate completed exit0 in42s:
`Abby E413 final current source and evidence gate`, log
`4590eee3-1792023762693.log`. `npm run typecheck`, both manifest/trace checks and
`git diff --check` passed, zero failures/skips. Counts overlap the compiled
contract stage. Publish through the existing draft457 and inspect its exact new
head; no merge or cloud qualification is established by these local checks.

## Gap4 follow-up: audited input and repeated booking/correction speech, October15

The previous conversational comparison turn made no implementation progress;
current work revalidated the pending verifier job as completed successfully and
continued from the actual uncommitted source and private evidence. The full
thirteen-gap objective is unchanged.

The new fixed synthetic booking corpus supplies sixteen pinned telephone clips
from eight source renders, two voices and quiet/noisy paired inputs. Four phrases
cover date/time, corrections, keeping an original appointment and changing
appointment duration. The builder exports private source/PCM/WAV evidence; the
bounded evaluator records actual acknowledged configuration and all transmitted
24 kHz audio hashes. The independent verifier reproduces noise, codec, WAV and
wire bytes and recalculates all stored scores. A fabricated passing assessment
and optimized-Python verification are rejected. This is evaluation tooling under
existing E2E-161/E2E-233 coverage, not a new full-call or acoustic qualification.

Forty-eight actual recognitions yield42 exact, one noncritical mismatch and five
critical misses. Quiet24/24 match; noisy18/24 match. Two critical misses are
ordinal formatting; three change a booking request into a past-tense assertion.
Overall1.85% WER is below the lexical threshold, but zero-critical acceptance
still fails. The original source-matched noise/safety failures remain required;
a regression prevents substituting this supplement. Codec identity passes all
256 mu-law values. Bandlimited interpolation and direct Realtime audio-to-text
screens still fail and are not promoted. No production adapter/default, original
corpus or threshold was changed.

See [the transcript-free aggregate](../eval/baselines/synthetic-booking-speech-20261015-v1.json),
[commands and limits](../eval/README.md#fixed-booking-date-and-correction-speech-supplement)
and [detailed findings](../eval/LIVE_BASELINE_2026-09-29.md#october-15-input-audit-and-fixed-booking-speech-supplement).
Current independent verification and false-pass denial passed in
`4590eee3-1792025900260.log`; the actual recognition job properly exits1 in
`4590eee3-1792025340912.log`. Source/type, fixture and gate-separation evidence is
recorded in that aggregate. Registry stays1.221/413; no passing test grants
natural-language admission. Real sender/recipient, clinic, cloud, acoustic and
carrier gates remain open. Recurring extra openings, complete class-cost and
staged quota/recovery, broader combinations, payment lifecycle, outbound
campaigns and approved document writeback also remain unfinished.

Final current-source validation: `npm run typecheck`, the six focused audio/fixture/
gate test files plus registry and no-number trace checks, and `git diff --check`
passed29 tests with zero failures, cancellations or skips in
`4590eee3-1792026233701.log` (1m05s). This checks the evaluation implementation;
the actual provider recognition assessment still fails.

## Gap6: independently approved native recurring opening occurrences, E2E-414

The official [AvailabilityBlock schema and operations](https://docs.api.cliniko.com/openapi/availability-block/availabilityblock)
return dated blocks with repeat metadata. The downloaded official OpenAPI
snapshot has SHA256
`4c354b3cb3fb9cf7ca91b5dd408b78f62896c62b89d265ba3190e5d2bd03740c`.
Cliniko's [fortnightly schedule guide](https://help.cliniko.com/en/articles/1023973-set-up-a-fortnightly-schedule)
explains how recurring extra openings support alternating schedules. These
sources establish the need and native shape; they do not justify synthesizing
additional dates from one returned rule or establish a real clinic's calendar.

The pre-change synthetic witness uses a valid legacy owner policy and a returned
dated extra opening with weekly metadata. Listing fails with zero clinical
writes; the transcript-free result is
`eval/baselines/native-opening-before-v1.json`, tracked in
`4590eee3-1792026470509.log`. The new contract first fails14/15 checks because
its new explicit owner-plan value is unsupported; legacy denial passes in
`4590eee3-1792026495285.log`.

`RosterSearchPlan.openingRecurrence: "nativeOccurrences"` separately authorizes
only the dated opening rows actually returned by Cliniko. Busy recurrence and
opening recurrence remain independent. Legacy plans still reject opening
recurrence. Unknown, inherited or malformed authority values are rejected.
Supported metadata uses the native Daily/Weekly/Monthly shape with positive
bounded intervals; no repeat rule generates another date. Daily and extra
openings still subtract complete busy records across practitioner businesses.
Both snapshots and native metadata must remain stable, and the selected day is
re-read before preparation and dispatch under the existing quota and deadline.

Native tests cover exact booking, no invented future dates, malformed rules,
snapshot change, policy withdrawal and a late cross-business block. Compiled
synthetic calls exercise the actual host, SMTP/private verification, PostgreSQL
budget, separately played selection/consent, native booking/inspection and
privacy scanning. Legacy opening authority and a late conflict deny writes.
No dependency, database migration, speech default, deadline or quota changed.

The first implementation regression passes78/80; two new assertions wrongly
expected hourly rather than fifteen-minute public choices and a `kind` tag
rather than an empty choices array. They are corrected without changing the
runtime. Log: `4590eee3-1792026521294.log`.

This closes the local inability to read approved dated native opening
occurrences. It does not establish undocumented future expansion, a complete
real calendar source or production acceptance. Broader source acceptance and all
external clinic/cloud/mail/acoustic/carrier gates remain open. The full thirteen
gaps remain active, including complete class cost/staging/recovery, payment,
outbound and document work.

The rebuilt full calendar run passes83 native checks and11/13 compiled checks;
two new compiled assertions expect uppercase `PM` whereas the actual played
menu has lowercase `pm`. Both positive and negative time matchers now ignore
case. This corrects presentation matching and strengthens legacy denial without
changing production code. The failed run is preserved in
`4590eee3-1792026562291.log`; the three affected compiled journeys are rerun
through actual consent, native write and late-conflict inspection.

Validation: current type/build and83 native calendar checks pass in `4590eee3-1792026562291.log`. The same run has11/13 compiled passes and2 new presentation assertions failing on lowercase pm. Only test case-insensitive time matching is corrected, including the negative matcher; all3 new compiled journeys then pass with zero failure/cancel/skip in `4590eee3-1792026969628.log`. The10 unchanged prior calendar journeys plus3 corrected new journeys qualify13 distinct compiled cases across these runs; the earlier failed run is retained. A final current-source typecheck plus2 manifest/trace checks and diff check passed in `4590eee3-1792026834554.log`. Registry1.222/414 records E2E-414 as syntheticImplemented with full-call planned. These counts overlap prior calendar evidence; they are not additional acoustic/provider qualifications.

## Gap10: observed native class workload and early original preservation, E2E-415

The previous goal turn made source and evidence progress before interruption:
it reproduced a concrete quota undercount and implemented private native shape
accounting. Current work revalidated the clean published base plus those exact
uncommitted changes; no prior live job was restarted.

The synthetic pre-change witness estimates161 requests for999 pass associations.
Adding201 cancelled attendance records per selected class leaves active places
unchanged, but execution attempts181 requests and becomes uncertain after all
three clinical legs, including original cancellation. The aggregate is
`eval/baselines/class-observed-workload-before-v1.json`; reproduction log:
`4590eee3-1792027354483.log`. This is not a production clinic observation.

Native class reads now retain only private aggregate metadata-page and complete
returned-attendance counts. Observed movement cost accounts for two paired class
and two destination observations, full metadata relationship pages, and a
replacement adding an attendance page. Destinations at the500-record inspection
bound deny before creation. Offer admission, fresh proposal inspection and the
coordinator's pre-replacement check use that current shape alongside the case
workload and known native proof floor. Unknown or oversized shapes cannot
prepare or send the original move. Existing authority, consent, snapshot,
physical quota, deadline and no-replay rules remain intact.

The first focused native regression passes66 reader/history/workload checks in
`4590eee3-1792027779676.log`, including successful forecast-to-claim equality,
metadata and attendance page boundaries, oversized denial, inspection overflow
and post-menu growth. Rebuilt actual signed runner qualification is required
before publication. See [class pass details](CLINIKO_CLASS_PASSES.md#observed-class-pagination-in-pass-movement-cost-e2e-415).

These observations do not reserve quota or bound arbitrary callbacks and future
native changes. Complete shared reservations, staged quota/recovery, broader
catalogue/correction/representative combinations, financial provisioning,
payment lifecycle, outbound and document work remain unfinished, along with the
actual clinic/source/cloud/mail/speech/carrier gates. The original full thirteen
gaps remain active; this milestone does not replace their completion criteria.

Final current-source qualification: `npm run typecheck`,281 native reader/movement/host/pass/history/case checks, `npm run build:voice-tests`, isolated PostgreSQL migrations and15 actual compiled class workload/history/movement journeys pass in `4590eee3-1792027858397.log`, with zero failures, cancellations or skips. The new compiled subgate includes two exact positive moves and early oversized denial. The final2 registry/trace checks and diff check pass in `4590eee3-1792028011822.log`. Counts overlap the earlier66-check focused run and existing scenarios; no acoustic or real clinic qualification is claimed. Registry1.223/415 records E2E-415 as syntheticImplemented with full-call planned.


## Gap10: shared account allocation, E2E-416

The previous conversational turn explained the intended product improvement but
changed no implementation state. Work resumed by inspecting both outstanding
jobs: the compiled composition finished with73 native passes and19/22 compiled
passes; the legacy-process witness failed. Both were terminal, and neither was
restarted on an observation timeout.

The new allocation scope protects a class move's current120/180-request admission
against other consumers sharing the account row. A separate-process compiled
competitor case passed, but older ordinary clients ignored the new table.
Migration048 now guards their timestamp writes at the database boundary.
The corrected fresh-schema run passes7 existing budget and9 allocation/upgrade
checks in `4590eee3-1792029907493.log`. The earlier command had a wrong test path
and stopped before tests (`4590eee3-1792029886474.log`); it is not qualification.
The pre-guard red witness is `4590eee3-1792029637083.log`.

Three compensation journeys initially time out in the full compiled run
(`4590eee3-1792029336672.log`). The isolated cancellation-denial case passes with
unchanged deadlines in `4590eee3-1792029927112.log`. A concurrent three-case run
passes both normal compensation journeys and exposes a different assertion:
the exhausted-owner fault consumes174 physical requests, not180, because its
120-request allocation stops it spending the six unallocated requests. Log:
`4590eee3-1792030001237.log`. The revised fixture records the exact denial and
claim count. The test requires exhausted allocation, unused physical capacity,
uncertain recovery, original preservation, replacement cancellation and no replay.
The first timeout's independent cause remains unestablished; no timeout or
concurrency gate is relaxed.

Additional current-source qualification adds actual owner-process death and
30-second database expiry, live-only timestamp counting and partial allocation
compatibility for legacy workers. Source typecheck, focused native/storage,
rebuilt compiled concurrency and registry qualification remain pending.
Shared allocations do not implement multi-window staging or durable recovery.
All thirteen original requirements remain active, including broader patient/
class/correction combinations, financial provisioning, payment lifecycle,
outbound, approved documents and real clinic/mail/operator/speech/carrier gates.

The broad compiled run passes22 allocation/observed-workload/ordinary-move
journeys and15 pass/history/correction/consent journeys in
`4590eee3-1792030267657.log`, with zero failures, cancellations or skips.
A subsequent review finds a retained-callback hole in the new wrapper: an
adapter could return denial and invoke its captured callback later. The new
regression first fails in `4590eee3-1792030761177.log`. The wrapper now closes
callback admission in a finally block. Denied, forged-success and throwing
adapters cannot start work after returning; the focused fix passes in
`4590eee3-1792030772965.log`. This is a working-change defect, not a real clinic
incident or a defect attributed to the published pre-feature base.

Final current-source qualification after that fix: `npm run typecheck`,74
focused native checks, isolated PostgreSQL migrations with7 prior budget and11
allocation/upgrade checks, `npm run build:voice-tests`,4 rebuilt compiled
independent-competitor/compensation/exhaustion journeys and `git diff --check`
pass in `4590eee3-1792030818771.log`. The storage cases include a realSIGKILL
and actual30-second expiry, legacy partial capacity and stale timestamp counting.
All final stages have zero failures, cancellations or skips. The4 compiled cases
overlap the earlier37; that broader run predates the callback-lifetime fix and
is recorded separately. No quota, deadline, concurrency or privacy gate changed.
Registry1.224/416 records synthetic implementation with full-call planned.
All thirteen gaps remain active; multi-window staging, durable recovery,
financial provisioning and broader combinations are unfinished, alongside real
clinic/source/operator/sender/recipient/speech/carrier and authoritative cloud
acceptance.


## Gap10: native staged quota execution and recovery discovery, E2E-417

The previous goal turn made implementation progress and published shared account
allocations at8aee54e. This turn inspected that clean base and split the native
move into separately admitted legs. The existing one-window path retains its
contract. See [the native staged interface](CLINIKO_CLASS_PASSES.md#native-staged-class-movement-e2e-417)
for scope, ownership, proof renewal, native footprint and remaining integration.

Early qualification exposed fixture/type defects. The old provider fixture
accepted only the legacy header and rejected the new structured stage review;
it now checks the exact header appropriate to the parsed operation. Two success
assertions then read a copied rather than live claim-counter getter; restoring
the getter produces the actual phase counts. Initial type errors involved
optional/narrowed closure state and readonly adversarial fixture mutation; the
runtime contract and compiler settings were not weakened. Failed logs:
`4590eee3-1792031863304.log`, `4590eee3-1792031981912.log`,
`4590eee3-1792032028124.log`, `4590eee3-1792032067946.log`,
`4590eee3-1792032826293.log`.

The first actual process run completed its native leg and discovery assertions
but failed the final privacy helper because it supplied strings where the scanner
requires label/value objects (`4590eee3-1792032404457.log`). Corrected scans and
both actual process journeys pass in `4590eee3-1792032874620.log`. A source review
also identified the real email proof's five-minute lifetime and protected-read
margin: later phases now explicitly accept independently issued same-subject
private proofs, with expired/wrong-subject denials, without extending old grants.
Those23 native checks and typecheck pass in `4590eee3-1792033601213.log`.

Final renewed-proof native/type/build/process qualification passes631 native
checks and2 actual PostgreSQL/process checks in `4590eee3-1792033781761.log`,
zero failures/cancellations/skips. Native counts include the23 new stage cases.
The prior628-native run and build passed in `4590eee3-1792033093420.log`; its
broader rebuilt legacy caller regression passes30 cases in
`4590eee3-1792033266220.log` before the final private-proof handoff addition.
These runs overlap and are not added as distinct new cases. Final rebuilt caller
and registry/type gates are recorded separately before publication.

Registry1.225/417 records text/native implementation with full-call planned.
Staged caller/SAM consent, actual verification renewal wiring, operator resolution,
no-pass/other membership staging, broader combinations and financial provisioning remain unfinished. This milestone
does not close gap10 or replace any original requirement. Payment lifecycle,
outbound and approved documents, real clinic/source/operator/mail/speech/carrier
acceptance and authoritative cloud checks remain open.

Final rebuilt caller boundary regression passes4 cases with zero failures,
cancellations or skips in `4590eee3-1792034404509.log`, after the private-proof
handoff addition. These overlap the earlier30 caller cases; they do not qualify
a staged caller route. Final current typecheck,2 manifest/trace checks and diff
check pass in `4590eee3-1792034288934.log`. The process tests follow the existing
isolated-PostgreSQL opt-in convention: the no-database text cohort intentionally
skips those2 cases (`4590eee3-1792034390453.log`), while actual PostgreSQL evidence
above runs both with zero skips. This keeps the ordinary text cohort independent
of a database and does not remove either case from the PostgreSQL proof job.

After the opt-in cohort wiring, the complete current-source typecheck passes in `4590eee3-1792034644945.log`; final2 registry/trace and diff checks pass in `4590eee3-1792034609622.log`. No staged caller, human recovery or cloud acceptance is inferred.
## Gap10: private verifier succession for native stages, E2E-418

The preceding comparison answer was no implementation progress. This turn
revalidated clean source at ae02e8a and open draft 457, inspected the actual
caller/SAM effect contract and private verifier lifecycle, then implemented the
identity handoff needed by staged caller execution. The original single-write
SAM receipt cannot represent a parked, partly completed movement; its staged
receipt/presentation/consent routing and operator integration remain unfinished.

`CallerVerificationSession.renewOnce` retires the previous owner before checking
current admission and returns one successor pinned to the original patient,
operation and call. A fresh challenge/code and independent current permission
are still required. It grants no consent, does not send automatically, does not
reset an unsuccessful challenge and never extends the previous proof expiry.
Concurrent, cancelled or late handoffs cannot restore old authority. No schema,
dependency, production route or speech threshold is changed.

The native bridge uses the actual verifier and stage engine for a cross-case,
different-service move with 999 linked and 201 roster records. It renews the
actual call lease while the first email attestation expires, obtains a fresh
proof and supplies a new stage confirmation. Verification reads themselves
consume Cliniko quota; the subsequent stage must wait for capacity. Withdrawing
permission after the new code prevents original cancellation and leaves the
native review unresolved. These fixtures exercise private composition, not
played caller confirmation or an admitted staged speech route.

Initial failures are retained: `4590eee3-1792035356765.log` used a nonexistent
fixture lease method; `4590eee3-1792035424403.log` moved the synthetic budget
clock backwards, preventing verification delivery; and
`4590eee3-1792035464956.log` expected immediate execution even though actual
verification reads consumed quota. The corrected fixture uses aligned clocks,
the actual lease method and the required quota wait, preserving all limits.
The first registry run (`4590eee3-1792035688391.log`) rejected a noncanonical
composition label; the metadata now uses the existing `standalone` enum.

Final focused native qualification: `node --test` over
`caller-verification-session`, `caller-verification-renewal`,
`class-move-verification-renewal`, `email-patient-authority`,
`transient-patient-proof`, `class-verification-account`, `verification-contact`
and `class-move-stages` in `test/cliniko`, followed by `npm run typecheck` and
`git diff --check`, passed 73 tests with zero failures/cancellations/skips and
passed typechecking. Tracked job `Abby E419 final renewal fault boundary native
and type gate`, exit 0, log `4590eee3-1792035524761.log`. Manifest 1.226 tracks 418
IDs; its two manifest/trace checks pass in `4590eee3-1792035728644.log`.

Staged caller/SAM prompts, new consent and private renewal routing, actual host
provisioning and staff resolution remain the next implementation work. The full
thirteen-gap objective stays active, including other membership models, broader
combinations, financial provisioning, payment lifecycle, outbound, approved
documents and all real clinic/source/operator/mail/speech/carrier/cloud gates.
The final rebuilt caller/PostgreSQL gate also passes: `npm run build:voice-tests`
then `bash scripts/with-postgres.sh bash -lc 'npm run db:migrate && node --test
--test-concurrency=2 test/cliniko/caller-verification-postgres.test.ts
test/voice/class-pass-move-runner.test.ts test/voice/class-move-runner.test.ts'`.
All 26 cases pass with zero failures/cancellations/skips, including the actual
renewal budget and database/backup scans. Tracked job `Abby E419 rebuilt caller
regression and actual PostgreSQL verifier renewal privacy`, exit 0, log
`4590eee3-1792035586448.log`. These compiled cases exercise existing caller
routes; the new staged route remains unfinished. Final complete current source
`npm run typecheck`, the two registry/trace checks and `git diff --check` pass in
`4590eee3-1792035807281.log`.


Final review found a disposal race after `verifiedSubject` returned but before
code entry published success. The caller session now checks that it is still
open and still owns the exact issued grant before pinning the subject. A new
microtask-disposal regression denies late success. This correction changes
neither proof lifetimes nor challenge/permission rules.

The final correction gate passes 74 native checks (including the new race),
complete typechecking and diff validation in `4590eee3-1792036017141.log`.
After rebuilding, the actual PostgreSQL renewal/privacy case and the compiled
successful full-pass caller case both pass, with zero failures/cancellations/
skips, in `4590eee3-1792036040613.log`. The earlier 26-case compiled regression
predates this narrow disposal fence; it is supplementary evidence. The two
registry/trace checks pass again before publication. Staged caller/SAM and
operator integration remain open.
## Local release parity and isolated database fixtures

The owner clarified that GitHub Actions billing must not hold up locally
verified merges. Earlier repository release evidence already records this
authorization. A clean detached checkout of f24ecaa, fresh locked dependencies
and Node 22.23.0 passed typechecking and started the complete local workflow
equivalents plus the existing release isolation guards. No repository rule,
workflow, deadline or assertion is weakened to accommodate billing.

The complete text cohort exposed seven newly added confirmation-resend and
patient-correction recovery files that assumed an externally provided database.
Some attempted a default connection and failed before email verification; others
threw at import. The text workflow provides no DATABASE_URL. These files now
own fresh migrated PostgreSQL through a private socket, using the existing
disposable fixture implementation. They also ignore ambient credentials, so
neither the text nor PostgreSQL cohort can accidentally use an unrelated
database. Every existing test still runs. The callback fixture remains available
to existing browser/storage tests; concurrent close waits for complete cleanup.

With actual databases, the first focused run reached 36 of 38 passing cases but
two synthetic RSA certificate generations exceeded the existing 10-second
fixture setup deadline (`4590eee3-1792036727329.log`). Synthetic SMTP now uses
P-256 certificates, retaining real TLS, CA/identity checks, transport faults and
all original time limits. The new resource cleanup test initially queried the
wrong migration table (`4590eee3-1792036872825.log`); it now checks the actual
Kysely migration history. Actual cleanup and recovery proof passes six cases in
`4590eee3-1792036907278.log`. No product cryptography is changed.

The corrected database/TLS group passes 59 tests with zero failures,
cancellations or skips in `4590eee3-1792037043489.log`. The separate private-code
SMTP group passes 12 in `4590eee3-1792037080372.log`. The original complete run
also found signed enquiry verification and within-deadline evidence timing
failures. Their exact two files pass five focused cases, preserving the four
workers and all original deadlines, in `4590eee3-1792037247098.log`. The cause of
those two complete-run timing failures remains uncertain; a focused pass does
not replace complete clean-commit qualification. Requalification and merge
remain pending. The full thirteen-gap goal remains active.


The 59-case corrected fixture group also passes complete typechecking and diff
validation (`4590eee3-1792037043489.exit` is 0). Registry/trace checks pass before
publication. A later failure in the original immutable complete run affected
the signed new-patient routed service case (E2E-353); its unchanged file is being
reproduced independently. No full clean-source release pass or merge is claimed.


The original clean f24ecaa run is terminal failed: 2390 tests, 2145 passed,
24 failed and 221 skipped in the normal text profile; later release stages did
not run. The record is `eval/results/local-release-f24ecaa/summary.json`.
Twenty-one failures belong to the missing-database fixture family; three affect
signed enquiry, within-deadline evidence and intake routing. The initial intake
reproduction failed a different mode (`groupFailure`) in
`4590eee3-1792037606519.log`. The next reproduction passed all 16 modes in
`4590eee3-1792037802620.log` after overlapping compilation/full-suite jobs ended.

Diagnostics now retain only public lifecycle/action/presentation/effect states,
fixed stage names and durations on failure, plus the static fixture step. They
exclude caller/provider text, native identifiers and verification material.
The first combined run exposed diagnostic masking after an expired call was disposed (4590eee3-1792037873338.log): the optional ledger read threw callUnknown instead of preserving effectFailure. The diagnostic read is now best effort and the original assertion remains unchanged. Complete typechecking, all three signed files together at concurrency 4 (six
tests), both registry/trace checks and diff validation pass with zero failures,
cancellations or skips in `4590eee3-1792038008914.log`. No runtime behavior,
deadline, concurrency or verifier was changed. Resource contention is suspected
but not established as the cause; a new complete clean-commit run remains the
merge gate and will be the sole owned qualification workload.


## Clean test-command dashboard prerequisite

The sole clean 366c004 run finished the main text cohort: 2411 tests, 2187 passed,
three failed, zero cancelled and 221 existing profile skips. The three failures
all occurred before authenticated staff HTTP inspection because
`dist/dashboard/app.js` did not exist. All earlier signed-call failures passed
in this full run. Its incremental record remains failed evidence at
`eval/results/local-release-366c004/summary.json`; later stages did not run.

The standard text and PostgreSQL commands now build the actual dashboard before
their Node cohorts. Previously only the browser command built that prerequisite,
while the development checkout's old bundle masked the dependency. Tests,
assertions, concurrency and deadlines are unchanged, and no dependency or product
code is added. With the old bundle moved aside, a fresh dashboard build and all
three authenticated recovery HTTP cases plus both registry/trace checks pass
without failures, cancellations or skips in `4590eee3-1792039145428.log`.
The next complete clean-commit local release remains required before merge.
The full thirteen-gap goal and separate clinical activation gates stay open.
