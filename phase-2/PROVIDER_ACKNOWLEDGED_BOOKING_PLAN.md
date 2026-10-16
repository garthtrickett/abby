# Plan for provider acknowledged booking

**Status:** Proposed, planning only. **Source reviewed:** `codex/abby-integrated-runner` at `4e19e1783e2324480c9e0d0923eeaf825e04692e`, whose main ancestor is `9a29e51e7f7e0a765db7674c6c75ff2087260473`. **Date:** 16 October 2026.

**Execution update:** The owner subsequently instructed work through [the execution order](EXECUTION_ORDER.md), including this prerequisite. [Progress](EXECUTION_PROGRESS.md) records staged implementation and actual checks. The original planning-only boundary below describes preparation of this proposal; it is not a new permission prompt after that instruction. The replacement host success policy remains proposed until each matching runtime step is delivered.

Simplify Abby's external PMS booking flow: prepare and authorize the exact request, check availability immediately before one write, and recognize an exact successful provider acknowledgement as booking success. Subsequent inspection cannot erase that result. Preserve verification, played confirmation, duplicate protection and Cliniko-owned crash recovery. Hosts that own their diary retain their stronger transactional contract.

This Abby proposal draws on Louis's Aeva workflow. His Aeva decisions do not approve an Abby clinic, a Cliniko recovery process or release activation. The current request is planning only; implementing it requires a separate go-ahead. This document does not amend the accepted D-16 contract by itself.

## Scope and delivery boundaries

The proposed change covers individual appointment creation through `ClinikoBookingHost`, including the same booking host after proven first-time registration. It also covers native class attendance creation through `ClinikoClassBookingHost`, including an already approved class pass. These are separate implementation steps because class capacity and pass consumption need different evidence.

Rescheduling, practitioner changes, cancellations, patient registration/correction, confirmation resend, class moves and pass relinking keep their existing operation-specific contracts. Review them as callers of shared code so a booking change cannot silently change their behaviour. A multi-stage move cannot become successful merely because its replacement attendance was created. Extending the new result policy to these operations would require a separate explicit scope decision.

No new provider is added. The rule describes external PMS booking generally; Cliniko is the concrete adapter changed here. Embedding Abby inside a monolith does not give an external PMS atomic guarantees. An owning-diary host keeps atomic target checks, exclusion and exact receipts.

## Current behaviour and affected modules

| Module | Current role and proposed work |
| --- | --- |
| [`ClinikoBookingHost`](../src/standalone/cliniko-booking-host.ts) | Saves provider-owned review, creates once, then requires exact readback, clear conflicts and current inspection authority before returning `committed`. Make a validated create acknowledgement establish success. |
| [`ClinikoBookingGuard`](../src/standalone/cliniko-booking-guard.ts) and [`ClinikoBookingOffers`](../src/standalone/cliniko-booking-offers.ts) | Refresh caller proof, policy, exact offer and availability. They currently await further proof/policy reads after availability. Separate preparation from the final exact availability read without bypassing their checks. |
| [`ClinikoAvailabilityReader`](../src/cliniko/availability.ts), [`ClinikoRosterAvailabilityReader`](../src/cliniko/roster-availability.ts) and [`ClinikoClassAttendanceReader`](../src/cliniko/class-attendance-read.ts) | Supply online slots, approved roster-derived intervals and native class places. Roster reads currently refresh metadata after calendar snapshots; class reads refresh proof after occurrence snapshots. Fix ordering inside these readers as needed, not only in their caller. Preserve the selected availability mode, all required pages and existing consistency checks. |
| [`ClinikoBookingWriter`](../src/cliniko/booking-write.ts) and [`bookingProviderRequest`](../src/standalone/cliniko-booking-authority.ts) | Capture the request, reserve account quota, run trusted authorization and issue one POST. Response matching checks patient, selection, start, marker and active status; the separate readback currently checks the end time. Bring the full confirmed interval into request and acknowledgement validation. |
| [`ClinikoReviewedSend`](../src/standalone/cliniko-reviewed-send.ts) | Requires acknowledged Cliniko review before invoking the one clinical send. Its deadline/abort wrapper can also classify a completed outcome as uncertain. Preserve an already established booking acknowledgement without changing the meaning of arbitrary results from other operations. |
| [`ClinikoClassBookingHost`](../src/standalone/cliniko-class-booking-host.ts), [`ClinikoClassPassBooking`](../src/standalone/cliniko-class-pass-booking.ts) and [`ClinikoClassAttendanceWriter`](../src/cliniko/class-attendance-write.ts) | Bind patient, native occurrence and optional case/pass, create one attendee, then inspect attendance, occurrence/capacity and pass usage before success. Separate valid attendee acknowledgement from subsequent observations while retaining eligibility and entitlement checks before send. |
| [`EffectWorker`](../src/core/effect-worker.ts), runtime and caller result presentation | Mark possible sending, bound host calls, accept typed results and present action status. Trace acknowledgement through these layers so later bookkeeping, speech failure or timeout does not manufacture a different booking result. |

Current accepted policy is in [ADR 0001](../docs/adr/0001-standalone-cliniko-write-contract.md), [write activation](CLINIKO_WRITE_ACTIVATION.md), [standalone booking](STANDALONE_CLINIKO_BOOKING.md) and [class passes](CLINIKO_CLASS_PASSES.md). These remain the baseline until a reviewed implementation revises the relevant booking provisions.

## Proposed booking sequence

1. Resolve the trusted clinic, provider account and operation. Verify the intended patient under the clinic's existing policy. Resolve the exact approved offer, practitioner, location, service, start, end and clinic timezone. Class bookings also resolve the exact occurrence and any approved entitlement.
2. Present those details and applicable terms through the current speech mechanism. Require completed playback and a separate affirmative caller turn. Corrections invalidate the old proposal and confirmation under the existing SAM rules.
3. Claim the action using the existing call/action ownership. Complete the Cliniko review request and require its exact acknowledgement. Refresh current proof, clinic/member approval, notification ownership, policy, write-stop, session and confirmed request bindings. Complete other patient/contact, eligibility, pass and provider metadata work here.
4. Obtain the write's account quota and complete any final authorization waits. Check the exact selected availability as the last provider read before dispatch. If any intervening work must wait afterward, repeat availability rather than dispatch using the older observation. No sleep, slot token, reservation service or new patient-specific ledger is introduced.
5. After the final availability response, perform only synchronous validation of its exact selection, fixed expiry, real call generation/lifetime, observed local cancellation/abort state and request binding; invoke the native write once. Preserve the existing shared write-stop checks during preparation and action marking; do not invent a synchronized in-memory copy of a remote stop. No further policy file read, patient lookup, quota wait or reporting call may sit between availability and sending.
6. Validate the native response against the captured confirmed request. An exact successful response establishes a committed booking. Immediately propagate that result through the existing action result handling.
7. A missing, unreadable, mismatched or ambiguous response remains unresolved. Preserve the existing provider-owned review and read-only discovery process. Never repeat the create, infer ownership from a matching diary row or compensate automatically.

Availability is an observation, not a reservation. A competing writer can still act after the last check. Fresh authorization also cannot prevent a remote permission change after its last read. The plan promises the stated ordering and accepted best-effort semantics, not an atomic transaction across Cliniko and Abby.

Implement this through an internal preparation and final-confirmation seam owned by the existing trusted booking modules. Keep model/agent inputs unchanged. Do not add a public skip-verification switch or turn an arbitrary caller-supplied availability object into permission to write. Preserve the existing live-proof checks during preparation; moving them before final availability must not silently delete them. Subsequent synchronous checks must observe the real call lifetime/generation rather than a new unsynchronized copy of policy.

For roster and class modes, a final availability observation spans multiple native reads. Finish required metadata and live authorization before the final complete calendar/occurrence observation; keep the existing inconsistency, pagination and over-limit refusals. There is no claim that those pages form an atomic snapshot. If preserving a required post-read validation causes new asynchronous preparation, repeat the exact capacity/calendar observation afterward within the original budget. Validate online, roster and class ordering separately.

Reserve/account for the final observation and create request under the existing shared Cliniko budget. Another caller exhausting quota must cause a bounded pre-send refusal or a fresh confirmation sequence, not a hidden wait after the final observation, a duplicate reservation or a quota bypass. Check cancellation while the final read is held and again immediately before invoking the transport.

## Acknowledgement and caller outcome

For individual creation, success requires HTTP 201, a bounded valid response, a valid native appointment ID, exact trusted patient/business/practitioner/type links, exact confirmed start and end, the request's correlation marker and explicit active status. Send the confirmed `ends_at` explicitly and validate it in the response; Cliniko documents it on both [creation input and returned appointment](https://docs.api.cliniko.com/openapi/individual-appointment/createindividualappointment-post). A missing end remains uncertain rather than triggering a mandatory diary GET to manufacture success. Copy the full request before waiting so callbacks cannot retarget it. A documented definitive native rejection can be mapped to rejection only when that exact response establishes no create; unfamiliar errors retain uncertainty.

For class creation, validate HTTP 201 and the exact attendee ID/self link, patient, native occurrence, correlation marker, active status and approved case association when applicable. Never accept a different pass/case or introduce one into a booking that did not authorize it; use documented no-association evidence where the contract requires absence. Acknowledgement proves the attendee creation. It does not prove payment, arrival, attendance, unused pass balance or atomic capacity exclusion. Keep the confirmed occurrence's identity/time/type bindings from the final preparation and capacity check.

The [attendee create interface](https://docs.api.cliniko.com/openapi/attendee/createattendee-post) binds a patient and booking, with an optional case; the acknowledgement does not echo every class time/type field. Validate those fields through the final occurrence observation and the response's exact occurrence link. An external edit after that observation remains an accepted race, not a reason to invent stronger response evidence.

| Established evidence | Booking result and handling |
| --- | --- |
| Preparation, review acknowledgement or final availability fails before a clinical send | No booking create is dispatched. Keep any already saved review visible; do not claim that earlier patient preparation was undone. |
| Exact valid create acknowledgement | Record success and use ordinary confirmation. A later conflict, inspection outage, proof expiry, observer failure or failed speech cannot turn that booking into an unknown or failed create. |
| Response is lost, malformed, incomplete, nonexact or ambiguous after possible send | Keep uncertain/needs-review handling and the provider-owned recovery item. No blind retry or completion claim. |
| Later diary state matches an uncertain request | Current state alone does not prove which writer created it or establish notification/fee effects. Keep the existing attribution limits. |
| Process dies before it records or speaks the received acknowledgement | Fresh-process discovery still finds the Cliniko review. Recovery does not replay the action or assert that the patient heard confirmation. |

The acknowledgement must be fully parsed and validated before it is established. Headers, a bare 201 or a response body still waiting to parse are insufficient. If a deadline/abort wins before that point, retain uncertainty. If the exact result has already been established, later wrapper checks must not discard it. Deliver the booking result through the existing host-result path before optional observers; do not simply remove abort checks from a generic helper and thereby bless unrelated operation results. Exercise both orderings at the provider parser, reviewed-send and effect-worker seams. A trusted late acknowledgement may resolve only its own action under existing result/version rules; it cannot reopen the call, replay the create or overwrite a different action.

Preserving an action result does not authorize new patient disclosure after verification expires. Do not fetch or speak fresh private details merely to explain a completed booking. An ended call must remain ended.

## Recovery and optional observation

Retain the acknowledged pre-send Cliniko review item. Abby may persist only the existing patient phone-to-ID mapping; no new local appointment, attempt, acknowledgement, transcript or patient-specific alert record is permitted. Hashing or encryption does not change that restriction.

Retain independent discovery using configured provider account and review type, complete bounded pagination, duplicate/malformed review handling, human ownership and backup/escalation requirements. The record remains review context: it is neither a unique send fence nor proof that the booking was sent. A replacement process must never dispatch the original mutation. Do not auto-close review items as incidental success cleanup.

Keep the existing distinctions between one action, a later explicit new action and a different caller. A process-local marker or consumed gate protects its existing scope; it must not be described as provider-enforced or cross-process exactly-once delivery. Changed ownership or a recovered review item cannot mint a new send permit for the old action.

Optional post-write conflict inspection is outside the booking success path. The default for this change is to retain the existing review process and introduce no new patient-specific alert or background observer. Existing inspection methods can remain for explicit authorized review. Any future automatic observer needs its own tracked lifecycle, current read authority and permitted staff destination; its errors must be contained, and it cannot create local prohibited data or alter the established booking result.

## Implementation steps and acceptance gates

### Step 1 Define the contract and exact individual receipt

Update the booking provisions in `PRD.md`, `TECHNICAL_DESIGN.md`, `CONTEXT.md`, activation and standalone booking documents, and record the scoped revision to ADR 0001. Preserve historical decisions and executed test evidence; add a new decision rather than pretending D-16 originally selected this policy. Keep cancellation, move, intake and owning-diary provisions explicit.

During staged delivery, label the new policy proposed until the matching runtime step is delivered. Activate the individual and class contract descriptions with their respective code changes; a documentation-first PR must not claim that either new behaviour already runs. Retain the old class contract until step 3 is complete.

Extend the captured standalone booking request and create-response matching to cover the exact confirmed interval. Exercise valid and invalid date/timezones, missing or changed response fields, foreign IDs, inactive status, malformed/oversized bodies and response loss. Existing owning-host guarantees continue to pass. This step alone must not replace the host success gate until the exact receipt checks exist.

### Step 2 Implement final availability and acknowledgement based individual booking

Make the guard/offers/writer seam own preparation followed by final availability, after the writer's quota wait. Reuse the same availability semantics as offer confirmation. Avoid an extra full round of expensive patient/metadata reads merely to compensate for poorly ordered work. Preserve original deadlines and handle paginated availability completely.

Include online and roster paths in this step. A host-only change that leaves roster metadata or proof refresh after the final calendar read does not satisfy the ordering requirement. Record the actual last provider read and the transport invocation in tests, including any shared budget/file/database waits, rather than asserting only that an availability function was called.

Change the booking host to return the exact validated acknowledgement immediately, with no required created-target or conflict GET. Audit the reviewed-send wrapper and effect worker together; keep the change narrow enough that shared cancellation, correction, resend and multi-stage operations retain their contracts. Cover existing-patient booking and downstream booking after proven registration. Registration success stays separate from appointment success.

### Step 3 Apply the contract to native class booking

Retain class-specific independent permission, exact occurrence, free-place/duplicate checks, played fee/member consent, current pass/case eligibility and quota coordination. Complete pass/history preparation before the final native occurrence/capacity observation, then send once. Handle an exhausted quota window before dispatch; it cannot justify extending proof expiry or using stale capacity.

Use exact attendee creation acknowledgement for booking success. A subsequent capacity race, duplicate observation or pass usage change remains staff review context. Acknowledge only the creation actually performed, not unrelated class move/cancellation/link stages. Add native-capacity and entitlement races to the same failure matrix as individual booking.

### Step 4 Verify composed flows and finish documentation

Run the actual admitted verification/menu/selection/confirmation/booking composition, provider-owned recovery, process-loss and privacy cases. Check ordinary and class caller wording and result readers. Update affected scenario descriptions/manifests and source documentation honestly; historical runs do not become proof of the new semantics. Review the exact combined change and report remaining clinic/live-provider acceptance separately from local tests.

## Required verification

| Case | Required observation |
| --- | --- |
| No valid proof, foreign tenant/provider, changed terms or missing played affirmation | No clinical write. No review record is saved before its own authority requirements pass. |
| Review acknowledgement lost or invalid | Zero clinical writes; possible saved review remains discoverable. |
| Patient/contact, policy, pass or quota work deliberately delayed | Final exact availability occurs after all preparation and waits; no subsequent asynchronous preparation appears before POST. |
| Exact slot disappears during preparation | Final availability refuses the create. |
| Final read malformed, paginated/incomplete, timed out, expired or interrupted | No create; bounded terminal result and no late send. |
| Exact response including end time or native attendee binding | One create and committed action; normal caller confirmation where the call is still eligible to speak. |
| Response has wrong/missing patient, selection, start/end, marker, native ID, case or active state | Uncertain result; no extra write or guessed success. |
| Review succeeds, send fails or loses its response | Saved review survives; recovery performs no mutation. A later matching row alone does not upgrade attribution. |
| Later conflict, unreadable readback, expired proof, stopped observer, failed speech or reporting | Previously validated acknowledgement remains success. No compensating cancel/delete or duplicate create. |
| Abort/deadline before response validation versus immediately after established acknowledgement | The first stays uncertain; the second retains success. Held parse/read and late-result tests distinguish these events instead of treating all aborts identically. |
| Parallel duplicate events, callers sharing a slot, or provider/staff concurrent edits | Existing per-action deduplication holds. Separate legitimate actions may race; no false atomic exclusion promise. |
| SIGKILL before review acknowledgement, after review before POST, during POST, and after acknowledgement before caller result | Fresh process discovers provider-owned review without retained patient/marker context and dispatches no replacement write. |
| Existing owning-diary, cancellation, reschedule, correction, resend and multi-stage class move cases | Their operation-specific guarantees and required remaining stages are preserved. |
| PostgreSQL rows/backups, stdout/stderr, logs, jobs and notices | No newly persisted patient-specific information; existing privacy canaries continue to pass. |

Start with the affected `test/cliniko/booking-write.test.ts`, `standalone-booking.test.ts`, `booking-offers.test.ts`, `booking-native-proof-bracket.test.ts`, `booking-best-effort-edge.test.ts` and `reviewed-send.test.ts` files. Extend the existing class and pass booking, booking-session and intake-booking cases rather than duplicating their whole fixtures. Use the existing process/PostgreSQL tests for composed and lost-context proof.

Commands to run during implementation, from the repository root:

```sh
npm ci
npm run typecheck
npm run build:voice-tests
node --test --test-concurrency=2 test/cliniko/booking-write.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-native-proof-bracket.test.ts test/cliniko/booking-best-effort-edge.test.ts test/cliniko/reviewed-send.test.ts
node --test --test-concurrency=2 test/cliniko/class-booking-host.test.ts test/cliniko/class-pass-booking-host.test.ts test/cliniko/booking-session.test.ts test/cliniko/intake-booking-session.test.ts
node --test --test-concurrency=2 test/cliniko/roster-booking.test.ts test/cliniko/long-booking-search.test.ts test/cliniko/standalone-cancellation.test.ts test/cliniko/standalone-rescheduling.test.ts test/text/effect-deadline.test.ts
bash scripts/with-postgres.sh bash -c 'npm run db:migrate && ABBY_LEDGER=postgres node --test --test-concurrency=2 test/cliniko/standalone-booking-postgres.test.ts test/cliniko/standalone-booking-process.test.ts test/cliniko/booking-offers-postgres.test.ts test/cliniko/booking-session-postgres.test.ts test/cliniko/intake-booking-postgres.test.ts test/cliniko/intake-booking-process.test.ts test/cliniko/reviewed-send-process.test.ts'
npm test
git diff --check
```

Run `test/storage/owning-host-write-contract.test.ts` in that disposable database environment as well. Select additional shared-operation and class PostgreSQL/process cases from the actual changed callers; the listed focused files are not a substitute for that review. Inspect executed counts: database/process suites skipped outside the isolated environment are not acceptance evidence. Use `work run` and `work wait` for long checks and an independent systemd scope for runs over roughly ten minutes. GitHub validation of the eventual implementation head remains separate. No live clinic call, provider mutation, mail send, activation or deployment is part of preparing this plan.

Before eventual clinic activation, run separately authorized manual acceptance with owned synthetic provider fixtures: ordinary and class success, exact provider readback after the caller result, and review discovery after interrupted work. Record caller wording, native IDs privately, source revision, provider state and cleanup. Manual readback verifies the test outcome; it must not become the runtime success gate again. Confirm the clinic accepts the remaining race and recovery policy; local or simulated provider tests do not replace that acceptance.

## Refinement record

The plan was refined through these self-review passes; this is not an independent review or implementation evidence.

| Pass | Finding and resolution |
| --- | --- |
| 1 Source and scope | Identified missing end-time validation in the create response and separate class/pass semantics. Required the full interval and exact native attendee/case binding, with separate delivery steps. |
| 2 Ordering and quota | Found metadata/proof work after roster/class snapshots. Added reader-level ordering, original deadlines, complete pagination and shared quota accounting; a host-only edit is insufficient. |
| 3 Failure and shared callers | Distinguished unparsed responses, established acknowledgement, wrapper deadline races and process loss. Retained provider-owned recovery and scoped shared-helper changes; multi-stage moves and owning-host guarantees remain explicit. |
| 4 Contract and evidence | Prevented documentation from claiming staged behaviour early, clarified the actual scope of deduplication and class case association, and separated manual activation from implementation tests. |

Planning is ready for review when every requested behaviour has an implementation step and acceptance case, all named sources/tests exist, and the only repository change is this proposed plan. Implementation readiness additionally requires accepting this revised booking contract and revalidating the then-current source and any newly affected callers. No claim of completed implementation follows from planning readiness.
