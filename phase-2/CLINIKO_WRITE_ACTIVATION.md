# Cliniko write activation contract

**Version:** 0.1, 2026-10-03. **Current standalone decision:** booking, cancellation, rescheduling, patient creation and patient-specific recalls are all `unavailable`. This contract defines what must change before each can be activated. It does not grant clinic approval or promote a demo success into caller permission.

Scope: individual appointments, first-time patient creation and the proposed Cliniko-owned recall workflow. Group bookings, treatment notes, invoices, arbitrary patient edits and recurring appointment mutations are outside this release. Cancellation always targets one occurrence; rescheduling remains an in-place move.

## 1. Authority and storage

Activation is permission to construct a provider-backed caller host at one tenant, clinic and location with one reviewed operation contract. It is separate from saving a raw setting. The effective mode is the intersection of host support, current operation permission, approved clinic policy and the admitted call's captured setting. A saved Boolean cannot create any missing authority.

The existing `createStandaloneTextComposition`, standalone voice composition and `DisabledStandaloneHost` continue to refuse patient writes and patient tasks. The embedded reference fixtures deliberately use synthetic authority and, where explicitly selected, authorized durable storage. They are test targets, not a route to promote the public Cliniko host.

D-06/D-11/D-12 remain fixed: Abby may durably retain only clinic-scoped patient phone↔Cliniko patient-ID links as patient-specific data. Appointment IDs/times, patient-specific action/attempt/receipt keys, consent records, draft fingerprints, request markers, call IDs and outcomes cannot be persisted in Abby. Hashing or encrypting those values does not create an exception. Provider and authorized embedded-host records may own those details; public policy versions and non-patient admin approval metadata may be retained independently.

## 2. Shared activation requirements

Every operation needs all applicable requirements below. A missing or expired requirement means `unavailable`; no averaging or partial score is permitted.

| Requirement | Evidence required before activation |
| --- | --- |
| A-01: current clinic authority | Reviewed, versioned clinic/location policy; authenticated operator approval; exact API account/business and credential binding; current operation permission. Clinic approval cannot assert an unproven provider guarantee. |
| A-02: caller authority | A clinic-approved, rehearsed verifier authorizes the exact operation for one current patient and call/session. Phone matching and demo attestation are insufficient. Proxy intake requires separate on-behalf authority. |
| A-03: exact informed confirmation | The core presents the approved target or draft and applicable fee/consent terms, records completed playback, then receives a separate final caller affirmation. An agent cannot supply playback or affirmation. Changed target, terms or draft invalidate that confirmation. |
| A-04: commit protection | The provider or owning host enforces the required target version, slot exclusion or patient uniqueness at mutation time across every competing writer, including its UI, other integrations and other Abby processes. A fresh read, process mutex, rate budget or successful post-write inspection is insufficient. |
| A-05: send and stop semantics | One approved attempt has a stable host-owned identity. Permission, policy and write stop are checked before dispatch. Abort before send prevents mutation; abort or stop after possible send remains uncertain. No blind automatic retry, replacement call replay or automatic compensation follows uncertainty. |
| A-06: exact outcome and loss | The owner can distinguish a committed request from a rejected request or unknown result, using its request/target evidence. An active/missing record does not prove a failed send; a later matching state does not by itself prove which writer caused it. True connection loss while processing, simultaneous owners and restart are tested. |
| A-07: owner of unresolved work | A permitted durable owner can recover uncertain patient work and notify/review it with a proven workflow. Strict standalone has no such Abby store; Cliniko must supply any required patient-specific recovery and review. Generic alerts and provider fallback cannot claim that staff received a request. |
| A-08: evidence and transport | Operation-specific whole-call, command, provider-race, lost-response, stop, privacy and isolated parallel E2Es pass on the reviewed revision. A participating clinic rehearses its policy. Real media/fallback and speech quality remain independent gates for voice activation; text contracts can be developed before a Twilio number exists. |

**Request-only is a separate capability.** It requires an approved, recoverable Cliniko-owned request and staff workflow even when no appointment is mutated. Until D-07/C1 is satisfied, request-only stays unavailable for every standalone patient action. Direct clinic contact is a truthful fallback, not proof of a saved request.

## 3. Cancellation — first activation candidate

**Input:** current clinic/call/session/policy, trusted verified patient, one selected appointment with exact patient/business/practitioner/type/start/end, approved fee terms, and one confirmed cancellation occurrence. The existing provider edge sends no patient free-text note and uses `apply_to_repeats=false`.

**Needed protection:** a conditional cancellation tied to the confirmed appointment version, or an owning-host transaction that validates the target and permission while excluding all competing edits through commit. Locking only Abby callers leaves Cliniko's UI and other integrations outside the protection. A scheduling rule or signed Boolean is not an atomic version check.

**Result:** committed only when the authorized occurrence's cancellation is established under that protection and its exact result contract. Changed/wrong/cancelled targets deny dispatch. A possibly sent PATCH with an unreadable or mismatched result remains uncertain; an unrelated cancellation cannot establish this request's fee/notification effects. Reconciliation may report known current state without attributing another actor's mutation to Abby, but cannot manufacture an exact committed receipt.

**Current evidence:** C-LOCAL-34/48/49/50 and C-LIVE-35/41/42 cover one-attempt writes, fresh exact reads, approved synthetic fee presentation, lost response, abort and demo lifecycle. E2E-264 adds a complete synthetic provider-backed cancellation call in which the target changes after the last read. The mutation occurs, the action remains uncertain, the caller hears pending review and repeated draining sends no second PATCH. Its separate provider case explicitly verifies the changed appointment was cancelled: truthful wording does not prevent that mutation.

**Remaining release proof:** clinic verifier and fee policy; atomic target protection; cross-owner attempt semantics; real provider processing loss and permitted recovery/review; deployed caller/transport gates. Cancellation does not need a new-slot reservation, so its target-protection proof can proceed independently of booking. It is still unavailable today.

## 4. Booking — collision protection

**Input:** the verified patient, exact current business/practitioner/type, proposed interval and time zone, current eligibility and approved policy, completed presentation/affirmation, and an owner-issued exact attempt identity.

**Required solution:** either (1) a provider-supported reservation that atomically rejects overlap and is consumed by exactly the intended appointment creation, or (2) an authorized owning diary transaction that enforces non-overlap against every competing editor and creates the appointment in that transaction. Its exclusivity must cover practitioner/time overlap, not merely equal slot strings, and be released or expire safely when a call ends. The buyer monolith can implement option 2 only when it actually owns all relevant diary mutation paths; wrapping the same Cliniko HTTP POST in a local transaction cannot do so.

The [owning-host appointment design](OWNING_HOST_WRITE_DESIGN.md) makes option 2 executable: database interval exclusion, conditional target revisions and atomic exact receipts. E2E-265 uses independent PostgreSQL connections to prove the native mechanism; it is not a production adapter or a Cliniko guarantee. The atomic final-commit design holds no slot while the caller speaks. Apply expiry/release requirements to an actual reservation implementation, not to an unreserved provisional offer.

A reservation must bind patient, clinic/business, practitioner, interval, service, policy and intended action; revalidate at consumption; and reject expired/foreign/double consumption. Its recovery, post-send expiry, notification ownership and lost-response receipt must be proven. Changing one participant's settings cannot bypass enforcement.

**Alternatives evaluated:** an Abby-only lock does not coordinate Cliniko users or integrations; availability reread leaves a read/write window; conflict GET detects a collision after creation; deleting or cancelling a newly created appointment as compensation is another uncertain write and does not establish atomic booking. Unavailable blocks are a candidate for investigation, not an established reservation: the documented create contract supplies no atomic block-to-appointment consumption or exclusion guarantee. A human request workflow is a separate request-only capability and must satisfy section 2.

**Post-write detection:** E2E-266 adds bounded conflict inspection to the synthetic embedded booking host before its existing committed receipt and during exact observation. Failed/malformed reads remain uncertain; a detected conflict cannot later be silently upgraded and triggers no automatic compensation. This does not prove exclusivity or cross-process recovery, supply an unresolved-work owner, or change standalone permissions.

**Current evidence:** demo C-LIVE-07/27 accepted two same-slot appointments and observed conflict afterward. C-LIVE-28/32/33 accepted direct POSTs after eligibility settings removed offers. E2E-226 uses a synthetic `exclusiveCommitPermitted` host attestation; it does not prove a Cliniko reservation. E2E-264 shows independent real writer instances accept two synthetic same-slot creates with different markers. No standalone primitive currently satisfies either solution; booking remains unavailable.

## 5. Rescheduling — target protection plus new-slot protection

**Input:** all cancellation target/authority/fee requirements plus one confirmed new interval, current eligibility and an owner-issued action identity.

**Required solution:** atomically validate the old target version, reserve/consume the non-overlapping new interval and move that same appointment. A failed move leaves the old appointment intact; an uncertain move is observed under the same owner identity. The protection must include the source target and destination interval in one transaction or documented provider-native equivalent. Separate cancel/create is forbidden. Two competing moves, an old-target edit and a booking for the destination interval must all participate in the same protection.

For an owning diary, E2E-265 demonstrates a conditional in-place update and interval exclusion in one transaction, rejecting competing moves and a competing destination booking while preserving the losing source. No separate long-lived reservation is required for this native final-commit option. Actual buyer policy/authority/recovery/notification and whole-call integration remain release requirements.

**Result:** only exact committed protected move permits confirmation. `movedWithConflict`, unreadable conflict/after-state and lost response remain unresolved; a conflict that later clears cannot retroactively authorize the unsafe original attempt or silently confirm it. No unproven compensation or second PATCH is issued.

**Current evidence:** C-LOCAL-36/48/49/50 and C-LIVE-37/38/41/42 cover in-place moves, exact duration, changed-target denial, conflict distinction and lost response. E2E-264 makes two independent writers move two appointments into one interval; both mutate before reporting `movedWithConflict`. Conflict inspection detects this failure rather than preventing it. Source-version and destination exclusivity are unproven; standalone rescheduling remains unavailable.

## 6. First-time patient creation

**Input:** one approved transient draft, independently established consent/privacy acceptance, patient-versus-proxy authority, current clinic intake policy and an exact attempt identity. The current search is an exact email/date-of-birth candidate search, not identity proof.

**Required protection:** provider/owning-host uniqueness or a documented idempotent create contract that coordinates concurrent intake attempts and permits exact recovery. The owner must apply the clinic's duplicate policy; an existing or ambiguous candidate triggers review instead of a guessed merge. Draft/consent changes invalidate the prepared request. Do not store a draft digest, demographics, DOB or attempt record in Abby to supply missing recovery.

**Result:** exact created patient receipt does not prove a booking or delivered staff task. A created patient followed by failed booking stays created in Cliniko and enters only a proven host workflow; Abby does not automatically delete it. An unknown create cannot be replayed because a later search is empty or because the process restarted.

**Current evidence:** C-LOCAL-42/43/44 and C-LIVE-39/40 cover consent/scope/draft binding, duplicate/ambiguous results, one process-local permit, lost response and creation followed by failed booking. E2E-264 lets two independent approved synthetic authorities observe an empty candidate result and create two patients. Cross-owner uniqueness, recovery, real clinic consent and a safe downstream route remain unproven; standalone creation remains unavailable.

## 7. Patient-specific recall/follow-up

**Input:** trusted patient/clinic scope, an approved dedicated recall type, clinic-local due date, a permitted exact request identity and concise approved request content; all durable patient-specific details belong in Cliniko.

**Required ownership:** the clinic approves who monitors the Cliniko queue, cadence, backup owner, acknowledgment, resolution/reassignment, overdue escalation and outage behavior. The provider must permit exact uncertain-create recovery across processes without an Abby patient-linked marker store, plus concurrent-request duplicate handling. A recall POST alone proves no assignment or human notification.

**Result:** an exact accepted recall can describe a saved request only under the approved workflow; staff acknowledgment/delivery require separate evidence. A lost response is unknown and never triggers a blind POST retry. An empty marker scan cannot prove a rejected POST. A later process cannot recover a lost marker merely because a test harness passes it in.

**Current evidence:** C-LOCAL-39/52 and C-LIVE-53 cover the dedicated-type API lifecycle, one writer's marker fence and observation-only recovery with a harness-supplied marker. E2E-264 shows two independent writer instances can create the same marker twice. Clinic workflow approval, durable owner recovery and concurrent-request semantics remain open; standalone handoff/request-only remain unavailable.

## 8. Public API evidence checked

The [official OpenAPI description](https://docs.api.cliniko.com/_bundle/openapi.json?download=) was read on 2026-10-03; SHA-256 `4c354b3cb3fb9cf7ca91b5dd408b78f62896c62b89d265ba3190e5d2bd03740c`. The reviewed write operations declare no conditional-version or idempotency request header. This is absence from the published contract, not proof the server never implements an undocumented mechanism.

- [Cancellation](https://docs.api.cliniko.com/openapi/individual-appointment/cancelindividualappointment-patch) accepts occurrence selection and cancellation fields, returning 204.
- [Appointment creation](https://docs.api.cliniko.com/openapi/individual-appointment/createindividualappointment-post) and [update](https://docs.api.cliniko.com/openapi/individual-appointment/updateindividualappointment-patch) expose fields and success/validation responses. They do not establish non-overlap commitment in the reviewed contract.
- [Conflict inspection](https://docs.api.cliniko.com/openapi/individual-appointment/getindividualappointmentconflicts-get) reads an existing appointment's conflict state.
- [Unavailable-block creation](https://docs.api.cliniko.com/openapi/unavailable-block/createunavailableblock-post) exists, but its reviewed contract does not establish an atomic appointment reservation/consumption.

A bounded demo test can falsify a candidate guarantee. A successful finite test alone cannot establish coverage of every editor or a provider guarantee. Promotion requires the owning provider/host's documented contract and adversarial evidence for the named deployment. No new live Cliniko mutation was run for this contract.

**Historical provider explanation, verified 2026-10-03:** in [issue 108, maintainer response](https://github.com/redguava/cliniko-api/issues/108#issuecomment-157761727), Cliniko repository member JohnColvin wrote on 2015-11-18 that overlapping bookings were deliberately permitted and directed integrators to post-create conflict inspection. This corroborates the unsafe-overlap mechanism, but the archived repository and old response are not a current guarantee that no protected endpoint can exist. C-LIVE-07/27 provide the separate demo observations; C-DOC-11 records the current published contract review. A supported atomic alternative still requires a current provider contract, not an assumption that every product using Cliniko must accept this race.

## 9. Proof, release and next implementation

E2E-264 uses the actual TypeScript provider edges with an adversarial synthetic provider; its six deterministic counterexamples distinguish instance-local fencing from provider/host guarantees for all five write kinds. The cancellation case also crosses the existing embedded media/voice, confirmation, effect and reconciliation interfaces. These are local synthetic evidence, not real Cliniko race observations or carrier proof. Full-call evidence remains planned.

The initial focused command stopped at two new fixture type errors (missing cancellation reason on observation and widened consent literal). Correcting the fixtures preserved all assertions. The corrected typecheck and complete two-file run passed 20 checks with no failures/skips. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791017457002.log`.

Final local verification on registered source `b48ddab1453f695ea3bf19f9e400789f04bcf999` passed:

- `npm run build:availability-console`, `npm run typecheck` and `git diff --check`.
- `node --test --test-concurrency=4 test/cliniko/write-activation.test.ts test/cliniko/cancellation-write.test.ts test/cliniko/reschedule-write.test.ts test/cliniko/booking-write.test.ts test/cliniko/patient-intake.test.ts test/cliniko/recalls.test.ts test/voice/embedded-cliniko-appointment-change-host-call.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts`: 79 passed, zero failures/skips.
- A disposable PostgreSQL instance through `bash scripts/with-postgres.sh`, then `ABBY_LEDGER=postgres npm run db:migrate` and `node --test --test-concurrency=4 test/composition/cross-mode-appointment-proposals.test.ts test/composition/cross-mode-agent-conformance.test.ts test/storage/standalone-privacy-journey.test.ts`: eight passed, zero failures/skips, including actual database and backup privacy scans. These commands ran in the same exported PostgreSQL environment.
- `node scripts/ordered-node-e2e.mjs` with `concurrency=4` dispatched `write-activation`, `embedded-cliniko-appointment-change-host-call`, `cancellation-write` and `reschedule-write` test files in that order and its reverse; 41 passed in each order, zero failures/skips. The runner verified actual dispatch and successful completion of every file.

Logs: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791018340151.log` (registered/provider/PostgreSQL) and `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791018357819.log` (both controlled parallel orders). No runtime, dependency, migration, provider permission or storage change was required. This is local evidence; carrier, live-provider activation and deployment gates remain open.

Before any promotion, the operation owner records exact scope/account/business, policy and credential versions, reviewed provider or owning-host guarantee, expiry/revocation owner, source/fixture versions, exact positive/denied/failure/race tests, permitted storage/recovery and clinic approval. Recheck current versions at proposal and commit; refuse changed bindings. Import/cutover must establish the destination's own proofs and force unsupported capabilities off rather than copying a source approval. Notification suppression/ownership stays a separate required host contract.

Implementation order: prove cancellation target protection and recovery first; investigate provider-owned booking exclusivity independently; combine source and destination protection for rescheduling; then prove intake uniqueness/downstream handling and approved recall ownership. Update the support matrix, contracts, scenario and owning host together when genuine new evidence becomes available. The current release remains disabled through its existing composition; this document adds no speculative production authorization layer or approval toggle.

## 10. Questions for a Cliniko provider contract

The [reference implementation trace](../docs/flows/cliniko-reference-write-trace.md) demonstrates a practical integration based on ordinary writes, delayed inspection, compensation and local durable queues/ledgers. We can implement and test known API behavior without a written guarantee. The questions below concern this contract's stronger atomic-target/interval and permitted recovery requirements; the inspected reference paths do not establish them. Their local patient-specific persistence cannot be copied into strict standalone Abby.

These questions identify the missing standalone evidence. They are prepared for the owner/API provider; no message has been sent and no production or demo mutation is authorized by this section.

1. **Conditional cancellation/update:** Is there a supported request precondition tied to the exact confirmed appointment version or fields? Does its check occur atomically with the mutation, including a concurrent UI/API edit? What exact rejection proves no cancellation, move, fee or notification side effect occurred? A response `ETag` alone would not prove a mutation precondition.
2. **Atomic interval exclusion:** Is there a supported create/move operation or consumable reservation that rejects practitioner interval overlap against every UI/API writer, including other business locations, direct appointment writes and concurrent moves? Specify buffers, expiry, consumption, permitted overrides, error results and how a rejected move preserves its source. Hiding offered times or returning conflicts afterward is insufficient.
3. **Exact attempt/outcome:** Is there a documented idempotency/request identity contract, including scope, exact payload binding, concurrent owners, retention and receipt lookup after real processing loss? Distinguish committed, rejected, pending and unknown; document whether any absence ever proves that no mutation was sent or committed.
4. **Cliniko-owned recovery:** Under Abby's phone-to-patient-ID-only storage rule, how can another owner discover an unresolved patient request and recover its exact provider-owned attempt without an Abby action/marker store? Is there a supported Cliniko-owned review queue and acknowledgment/escalation contract? Harness-supplied keys and generic alerts cannot supply lost-context recovery.
5. **Create and downstream semantics:** What provider guarantees coordinate duplicate patient creates and duplicate recall requests? Which fees, confirmations, reminders, practitioner notifications or staff-work records are emitted by successful, rejected and repeated operations, and who owns suppression and uncertain-result review?

For a proposed guarantee, request its supported endpoint/version, exact request/response contract, all participating writer paths, exceptions/overrides, retention/recovery semantics and deployment limitations. Then add bounded authorized adversarial probes and whole-call proof for that contract. Do not enable a mode based only on a finite successful demo, an undocumented header or a provider marketing statement.
