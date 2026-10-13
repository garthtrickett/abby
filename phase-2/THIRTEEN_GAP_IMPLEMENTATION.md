# Cliniko integration: thirteen-gap implementation order

Activated by the owner: bridge all thirteen gaps in the agreed order, including every part that can be completed without a Twilio number. The October 10 source comparison is an inventory, not a completion claim. Existing no-number contracts and privacy rules still apply.

## Requirements and evidence needed

| Order | Requirement | Current work and completion evidence |
| --- | --- | --- |
| 1 | Wire existing booking, enquiry, cancellation, rescheduling and intake into the running receptionist. | Local engineering proof now covers all five workflows through separately compiled runner subprocesses, signed serving paths, private verification, played confirmation, current-policy denial, independent permission, delivery loss and no replay. CI and real activation remain open under gaps 2–4. |
| 2 | Connect caller verification and clinic-approved permissions. | Separate draft PR 454 adds real TLS SMTP to the actual verifier/protected read with synthetic data; typecheck and 22 checks passed, including failed delivery and independent permission denial. Real sender/mailbox, accepted clinic policy and deploying-host permission source remain open. Channel possession alone cannot grant proxy/minor authority. |
| 3 | Establish message delivery, staff handoff, monitoring and recovery ownership. | Four compiled-runner staff journeys now pass: named saved request, unknown write without replay, permission denial before mail and revocation before send. Existing recall/review/aggregate contracts remain. Deployed monitoring receiver, real sender and human clinic process remain open. |
| 4 | Complete synthetic speech, public transport and eventual carrier qualification. | Prior synthetic runtime evidence exists; noisy/safety and repeated speech gates remain open. Paid probes require restored credits; public tunnel requires a dedicated usable route. Twilio-number carrier evidence is deferred, not substituted with synthetic results. |
| 5 | Expand services, duration choices, locations and initial/follow-up rules. | Current one-type/one-business clinical cohort is insufficient. Require several independently approved services and correct routing of corrections and initial/follow-up/return rules. |
| 6 | Extend searches and support online-disabled services where required. | Current bounded online cohort is insufficient. Require roster/extra availability minus all busy sources, incomplete-source denial, date bounds and offer/commit agreement. |
| 7 | Support another approved practitioner during rescheduling. | Current movement requires the same practitioner. Require destination approval, single in-place movement and truthful recovery for conflicts/unknown writes. |
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
