# Standalone Cliniko write contract and recovery design

**Status:** best-effort engineering contract accepted by the product owner on 2026-10-04 (D-16). The owner explicitly chose to build the Cliniko workflow and accept concurrent edits, overlaps and duplicates. Clinic approval, recovery implementation and each operation’s release proof remain required; all current standalone write modes remain unavailable. The nine-step objective remains intact.

## 1. Accepted decision

Adopt a distinct best-effort contract for standalone Cliniko, while retaining the atomic owning-host contract for an authorized embedded buyer. This changes the engineering release criteria in D-15, D-02/D-04 and the corresponding PRD/design requirements. Product selection is recorded; executable capabilities require their separate implementation and clinic approval gates.

The trade-off is concrete: an appointment can change after Abby's final read, two writers can create overlapping appointments, and duplicate patient/request records can occur. Post-write inspection detects some failures after mutation; it cannot prevent all competing UI/API writes. Product has accepted these concurrency limits; a participating clinic must also accept the applicable operation policy before activation. It does not relax privacy, informed confirmation, verification or outcome honesty.

The alternative is to keep the current strict contract, with these standalone operations unavailable until a supported protected provider mechanism is established. The native owning-diary PostgreSQL proof remains useful for acquisition integration; it cannot lock Cliniko's external diary.

## 2. Unchanged requirements

- Abby durably retains only clinic-scoped patient phone-to-Cliniko-patient-ID links as patient-specific data. No local call/request/attempt/appointment/consent/outcome store, durable retry queue, patient-bearing log or disguised digest exception is added.
- Clinic/account/business/credential bindings and approved versioned policies are revalidated before dispatch. Caller verification, operation authority, completed presentation and separate final affirmation remain mandatory.
- Cancelling means one occurrence; rescheduling means moving the existing appointment. Group/recurring mutations stay outside this scope.
- Every possible appointment mutation is attempted once by the current active owner. A lost response, process restart or later matching state never authorizes automatic resend or compensation.
- Unknown permission, changed target/terms, failed eligibility/readiness or an unapproved/unavailable review workflow blocks new dispatch.
- No missing prerequisite is manufactured by a setting toggle, model output, synthetic authority or generic operational alert.

## 3. Proposed operation behavior

| Operation | Before send | After possible send | Honest limitation |
| --- | --- | --- | --- |
| Cancellation | Verify exact patient and current target, business, practitioner, type, interval and applicable fees; compare with caller-confirmed snapshot | One occurrence PATCH, then exact read-back. A clear successful response and expected read-back may confirm under the approved best-effort contract; otherwise preserve uncertainty for review | The final read and PATCH are separate; a competing edit may occur between them. A later cancelled state alone cannot attribute fee/notification effects to this attempt |
| Booking | Recheck approved current selection/eligibility and requested interval, capture confirmation and create an acknowledged Cliniko-owned review request | One POST; match returned patient/selection/time/marker; bounded conflict GET before confirmation. Failed or conflicting inspection stays unresolved; no automatic cancel | A clear conflict read is current observation, not interval exclusion. Another writer may create overlap afterward or while inspection occurs |
| Rescheduling | Recheck exact source snapshot, confirmed new interval, policy and terms | One in-place PATCH; exact old/new-state and conflict inspection. Unknown or conflicting state stays unresolved; no automatic reversal | Neither source-version protection nor destination exclusivity is atomic across Cliniko writers |
| First-time intake | Approved exact draft, consent/proxy policy and duplicate search | One possible create; exact returned patient evidence, no blind replay/merge/delete; separately authorize any later booking | A patient-linked recall cannot be created before the patient exists. The appointment recovery design below does not solve pre-patient intake recovery or cross-owner duplicate creation |

A proven acknowledged review request is a precondition for the appointment execution paths. First-time intake remains an explicit step-7 design and proof obligation; do not silently claim that an existing-patient queue covers it. A supported Cliniko-owned intake record/workflow must be established, or product must explicitly choose and specify a different truthful failure contract before intake is implemented for callers.

## 4. Cliniko-owned review candidate

Use a dedicated clinic-approved recall type for confirmed existing-patient appointment requests. The existing recall writer supplies one-attempt creation; the current aggregate pulse supplies bounded queue-health counts. Lost-context discovery is implemented in E2E-267; an actual staff UI/workflow rehearsal remains open.

Proposed ordering:

1. Receive exact caller confirmation while current proof, policy and session remain valid.
2. POST one unrecalled, dated Cliniko recall with a versioned, bounded request envelope: location/account binding, random attempt identity, operation, exact approved target/interval and policy references needed for review. The confirmed patient ID in the envelope must match the recall's Cliniko patient link; a changed association becomes invalid review work. No audio/transcript or unrelated chart data is copied into the envelope.
3. Validate its exact successful response before any appointment send. An uncertain recall create blocks the appointment write. The caller hears that the request cannot yet be confirmed; no automatic second recall POST follows. A committed but response-lost recall remains discoverable in Cliniko for human review.
4. With current authority/stop/target checks still satisfied, dispatch the one appointment mutation and inspect its result under section 3. Never infer sent/not-sent from the saved request's presence or its timestamp.
5. Keep an unresolved review item visible in Cliniko after uncertainty or process loss. Initially, only staff mark the item resolved/recalled after reviewing provider state and contacting the caller as needed. Automated receipt annotation/closure requires a separately proven contract; it must not hide uncertain work when a later record update fails.
6. A fresh owner discovers pending requests from Cliniko using account/type configuration alone. It must not require a lost in-memory patient ID, marker or harness-supplied original request. Recovery is observation and human review, not an automatic mutation dispatcher.

The record is a **review request**, not an atomic operation receipt or provider-enforced send fence. Staff may see an item whose action was never sent, completed, conflicted or left unknown. Multiple recalls with the same marker, malformed/edited envelopes and changed targets must be surfaced as ambiguous review work, not automatically resolved or replayed. The human process must handle the original process still being alive; a recovery scan is not proof the sender died.

Cliniko's report location filters describe the patient's most recent business, not necessarily the requested action location. An approved clinic must review the full dedicated type and use the envelope's validated location, so those report filters cannot silently hide requests. Staff ownership, cadence, backup, acknowledgment, resolution, overdue escalation and outages require clinic acceptance under D-07.

## 5. Required proof before this candidate is usable

- Fresh-process discovery after losing every local patient/marker/request variable; committed and noncommitted recall-create response loss; crash after acknowledged recall but before mutation, during mutation and before result review.
- No appointment send before exact queue acknowledgment; no replay or compensation by replacement owners; duplicate/edited/conflicting request handling and independent owner races.
- Complete bounded pagination, status/link/type validation and over-limit/inconsistent-page denial. GET recall filtering does not document a type filter, so account scan limits and recovery coverage must be measured and specified. A partial scan must never be described as an empty/healthy queue or complete recovery. Pages are not a point-in-time snapshot; even a successful empty scan does not prove an earlier create never committed.
- Operator-authorized transient inspection in Cliniko; patient data absent from Abby database, backup, logs and aggregate alert bodies. Confirm the provider-owned envelope can be viewed and understood through actual Cliniko UI, not only through an API fixture.
- Named staff owner and backup, accepted review cadence, manual resolution meaning, escalation and staff rehearsal. API success or the provider's `recalled` flag alone is not staff acknowledgment of this protocol.
- Whole text journeys first, synthetic voice and parallel isolation afterward. Twilio carrier proof remains a separate prerequisite for telephone activation.

## 6. Acceptance and implementation order

| Goal step | Concrete completion evidence | Current status |
| --- | --- | --- |
| 1. Agree standalone write contract | Explicit product decision recorded; PRD, technical design, D-15 and support matrix agree about standalone best-effort versus owning-host atomic semantics | Accepted D-16; PRD, technical design, activation contract and support matrix aligned |
| 2. Cliniko-owned recovery/staff review | Provider-backed lost-context discovery, required failure/race/scan/privacy proofs and actual accepted staff workflow | Bounded discovery implemented (E2E-267); acknowledged pre-send seam implemented (E2E-268); C-LIVE-54 proves current provider persistence and fresh account/type discovery; C-LIVE-56 rechecks the still-pending supervised UI fixture with no marked-recalled item; human witness remains missing; E2E-272 adds a text cancellation composition with synthetic authority/mail/provider; production caller integration and accepted clinic process remain open |
| 3. Caller verification/policies | Actual clinic-approved verification source and operation/fee/consent policies, with denial/expiry/revocation and disclosure E2Es | Email one-time code implemented locally (D-17/E2E-269); E2E-273 adds fresh contact/candidate/permission/source-expiry checks on every protected proof use; E2E-294 adds opt-in authenticated synthetic private keypad voice entry with actual verifier/protected read, quiet resume fence and PostgreSQL/backup proof; actual clinical permission source, delivery, production runner wiring and clinic activation remain open |
| 4. Cancellation | Standalone text path using steps 1–3; exact confirmation, real provider lifecycle and adversarial failures; operation-specific activation evidence | [Standalone text host](STANDALONE_CLINIKO_CANCELLATION.md) now composes email proof, actual gateway/SAM, required provider review and one inspected cancellation; synthetic authority/mail/provider only, caller capability unavailable |
| 5. Booking | Same approved composition, current offers/eligibility, one create and conflict handling; whole-call and failure evidence | [Standalone booking](STANDALONE_CLINIKO_BOOKING.md) now includes concrete clinic policy/offers, admitted email-code owner and actual agent played menu/selection/confirmation, one reviewed inspected create, coordinated PostgreSQL/backup and owner-loss proofs (E2E-279–284); synthetic provider/mail/permission/approvals only, production caller capability unavailable |
| 6. Rescheduling | Confirmed source/destination, in-place move, exact uncertainty/review behavior and E2Es | [Standalone reviewed move](STANDALONE_CLINIKO_RESCHEDULING.md) now connects actual verifier/gateway/SAM/provider review and one inspected PATCH with final authority callbacks, PostgreSQL/backup and sender-loss proofs (E2E-285/286); admitted owner/played private source and destination menus plus concrete policy/selection composition implemented (E2E-287–290); approvals/permission/mail/provider remain synthetic and live activation remains open |
| 7. First-time intake | Approved consent/duplicate policy, provider-owned pre-patient failure/recovery contract and safe downstream workflow | [Separate intake proposal](STANDALONE_CLINIKO_FIRST_TIME_INTAKE.md), memo research E2E-291, exact provider receipt/lifetime E2E-292 and public eligibility/recorded-consent policy E2E-293; D-18 remains unselected, caller intake implementation/actual activation remain open and the existing-patient recall candidate does not supply pre-patient recovery |
| 8. Email/HTTPS/alerts | Actual mail acceptance, deployed TLS, provisioned identities and independently exercised operational schedules | Local synthetic mail/HTTPS/operational foundations exist; external configuration remains needed |
| 9. Speech | Source-matched live OpenAI recorded/generated-audio evaluations with declared quality and latency gates | Recorded/generated patient-free OpenAI testing exists; C-LOCAL-75 revalidates current adapter/evaluator report hashes: clean transcription and queued speech pass, noise/safety fail accuracy. No new provider evaluation is claimed; representative carrier/human and release gates remain unverified |

Agreement on an engineering contract does not approve a clinic, fee policy or recall workflow. If selected, implement in this order, add E2Es for each new feature/setting, and preserve provider/core seams for the acquisition host. Do not declare the nine-step objective complete while any row remains unproven.

## 7. Evidence inspected

Baseline Abby `0761370dc3569ce0a85d7c2c5e780128a9e80069`. Existing provider edges and transient hosts, D-06/D-07/D-11/D-12/D-15, C-LOCAL-53/54/55 and the current [activation contract](CLINIKO_WRITE_ACTIVATION.md) establish the present limits.

On 2026-10-04 the [official OpenAPI bundle](https://docs.api.cliniko.com/_bundle/openapi.json?download=) was downloaded and inspected; SHA-256 `4c354b3cb3fb9cf7ca91b5dd408b78f62896c62b89d265ba3190e5d2bd03740c`, unchanged from the earlier dated snapshot. Recall creation requires a patient association and provides notes/date/type; list filtering does not establish a type filter or an atomic replay contract. [Recall API](https://docs.api.cliniko.com/openapi/recall), [recall setup and staff report](https://help.cliniko.com/en/articles/8410284-set-up-patient-recalls), [recalling patients](https://help.cliniko.com/en/articles/1023943-recalling-patients).

The pre-mutation review protocol above is an engineering inference from these documented primitives, not a Cliniko-endorsed transaction contract or observed staff workflow. No live clinical mutation, credential access or external message was performed to prepare this proposal.

## 8. Discovery implementation boundary

`encodeClinikoReview` creates the bounded version-2 envelope; `ClinikoRecallReader.discoverPendingReviews` needs only configured account/clinic and type. It returns transient review context or explicit invalid/ambiguous entries after a complete bounded account scan; it is not an agent command, staff authorization source or mutation dispatcher. E2E-267 exercises a killed sender and fresh discovery with PostgreSQL/backup/output privacy checks. The current reader refuses account scans above 500 rows and does not promise a snapshot. C-LIVE-54 adds current-envelope provider persistence and fresh account/type discovery, with verified demo fixture cleanup. The separate supervised UI fixture awaits a real human witness; accepted clinic staff process, real caller pre-send integration, caller authority and full release activation remain required.

## 9. Delegated supervised demo review defaults

The product owner asked Abby to choose the demo process on 2026-10-04. Garth Trickett is the primary reviewer. Review all pending items of the dedicated Abby type after every synthetic write/failure test and before the next write test; use no location filter that could hide another requested location. If the primary is absent, the demo pauses rather than silently assigning work to an invented backup. The production backup role is the clinic duty manager, currently unassigned: production activation requires a named person/coverage, accepted cadence and independent rehearsal. Never tell a caller staff received or resolved work solely because the recall POST succeeded.

During the rehearsal, the primary must actually locate and read each envelope in Cliniko, distinguish never-sent/success/unknown/conflicting examples without replay, verify the patient/location/target, and mark recalled only after the item is resolved. Unknown writes require provider-state inspection and caller contact as appropriate. Failed discovery or account limits stop test writes; generic operational alerts contain no patient/request content. These are defaults authorized for the supervised demo, not evidence that the reviewer has performed the rehearsal.

## 10. Acknowledged pre-send seam

`ClinikoReviewedSend` owns a single process-local attempt and a private copy of the confirmed envelope. A trusted host authorization port checks confirmation, live proof/policy/terms/target/write-stop state both before the recall and immediately before the clinical send. The gate validates configured account/location/business/credential/policy/time-zone bindings, creates one dated Cliniko review request, and requires the recall writer's exact successful acknowledgment. No acknowledgment, denial, stop, timeout or disconnect can release a clinical send. Once the send is invoked, throws/abort/response loss remain uncertain; there is no automatic recall closure, retry or compensation.

This seam must be owned by the active call coordinator; constructing a new gate is not recovery or permission to replay. A recall's existence, decoded envelope or `recalled` flag never mints caller authority. E2E-268 supplies synthetic text ordering and fresh-process database/backup/output privacy tests at before/during/after-send checkpoints. It is not yet wired to real standalone caller intents. Actual verification, operation receipts, Cliniko UI/staff rehearsal and clinical release gates remain open.

## 11. Exact cancellation reason in recovery context

Version-2 cancellation envelopes require the approved Cliniko cancellation reason (10/20/30/40/50/60), projected from the same confirmed provider request as the one possible clinical send. The target interval and terms-version reference alone cannot reconstruct that reason. A reason is review context, not proof that the original sender applied it, charged a fee or sent a notification. Do not infer attribution from later mutable state.

Version-1 records are not silently upgraded with an assumed reason. The bounded scanner keeps them visible as invalid-envelope work for manual inspection in Cliniko; it does not archive, resolve or replay them. Production caller writes remain inactive, and no live review records were created by this protocol change. E2E-270 checks all accepted reason values through acknowledgment/independent discovery plus missing/mistyped/legacy denial.

Pre-patient research follow-up: the 2026-10-04 [communication API schema](https://docs.api.cliniko.com/openapi/communication) describes memo creation and includes `patient_id` without a required-field declaration in the downloaded bundle. This is only a candidate to investigate: it does not prove that the account permits a patient-less memo, that staff can discover/view it, or that its lifecycle can own an intake request. Verify those behaviors before revising the unresolved step-7 contract; do not attach a request to an unrelated chart or create a dummy patient.

## 12. Pre-patient memo research outcome

The official legacy communication property table requires `patient_id`. The demo-account probes on 2026-10-04 rejected both omitted and null patient associations with a patient-field error; independent account discovery found zero active research memos afterward. No patient or appointment was created. This memo candidate does not supply the pre-patient queue required by the current contract. The [reviewable step-7 proposal](STANDALONE_CLINIKO_FIRST_TIME_INTAKE.md) offers caller-mediated loss recovery as a material product choice; it remains unselected and does not weaken existing appointment pre-send review. Exact source and commands are recorded in the evidence log.
