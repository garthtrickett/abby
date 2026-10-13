# Cliniko integration: thirteen-gap implementation order

Activated by the owner: bridge all thirteen gaps in the agreed order, including every part that can be completed without a Twilio number. The October 10 source comparison is an inventory, not a completion claim. Existing no-number contracts and privacy rules still apply.

## Requirements and evidence needed

| Order | Requirement | Current work and completion evidence |
| --- | --- | --- |
| 1 | Wire existing booking, enquiry, cancellation, rescheduling and intake into the running receptionist. | In progress: clinic-owned composition through the standalone server and exported runner. Require actual signed serving-path journeys, private verification, played confirmation, denial/revocation and no replay. Real clinical activation remains separately gated. |
| 2 | Connect caller verification and clinic-approved permissions. | Existing operation-bound interfaces; complete delivery integration and deploying-host permission wiring. Channel possession alone cannot grant proxy/minor authority. Require operation-specific positive/denied/lost-delivery journeys. |
| 3 | Establish message delivery, staff handoff, monitoring and recovery ownership. | Existing recall/review/aggregate contracts; deployed receiver, real sender and human clinic process remain open. Build and test all independent adapters before external provisioning. |
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
