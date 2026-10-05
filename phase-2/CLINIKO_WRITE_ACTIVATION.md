# Cliniko write activation contract

**Version:** 0.2, 2026-10-04. **Engineering decision:** D-16 accepts best-effort standalone Cliniko writes and their concurrency limits. **Current executable decision:** booking, cancellation, rescheduling, patient creation and patient-specific recalls remain `unavailable` until the applicable implementation, clinic and recovery gates pass. Acceptance of this contract is not clinic approval.

Scope: individual appointments, first-time intake and Cliniko-owned staff review. Group bookings, recurring appointment changes, treatment notes, invoices and arbitrary patient edits remain outside this release. Cancellation targets one occurrence; rescheduling is an in-place move.

## 1. Authority, storage and host contracts

Standalone Cliniko uses exact validation, one possible send, post-write inspection and approved Cliniko-owned review. It explicitly accepts competing edits after the final read, overlapping bookings/moves and duplicate patient/request creation. It does not claim provider-enforced conditional targets, atomic exclusivity or cross-writer idempotency. The [accepted design](STANDALONE_CLINIKO_WRITE_PROPOSAL.md) records the ordering, trade-offs and nine-step completion criteria.

An authorized embedded host that owns its diary retains atomic target revision, interval exclusion and exact receipt requirements. The [owning-host design](OWNING_HOST_WRITE_DESIGN.md) supplies a PostgreSQL proof, not a Cliniko transaction wrapper. A buyer embedding Abby against an external PMS must declare that adapter's actual contract rather than inherit atomic guarantees from the fact it is a monolith.

D-06/D-11/D-12 remain fixed: Abby durably stores only clinic-scoped patient phone-to-Cliniko-patient-ID lookup links as patient-specific data. No call, appointment, consent, draft, request, attempt, outcome or review record, including hashes/encryption, goes into an Abby database, log, queue or backup. Cliniko or an explicitly authorized owning host supplies patient-specific durable records. Non-patient clinic approval/policy metadata remains permitted.

The current standalone compositions and `DisabledStandaloneHost` remain disabled. A future adapter must enforce the effective intersection of declared host support, current operation permission, clinic policy and admitted-call settings. A Boolean cannot create missing authority, workflow or recovery evidence.

## 2. Shared activation requirements

| Requirement | Evidence required before activation |
| --- | --- |
| A-01: current clinic authority | Authenticated, versioned clinic/location approval bound to the exact provider account/business/credential; approved operation, concurrency limits and notification ownership. Product acceptance alone does not approve a clinic. |
| A-02: caller authority | A clinic-approved verifier authorizes one intended patient, operation and call/session. Phone match and synthetic attestation are not proof. Consent/proxy authority are explicit where applicable. |
| A-03: exact informed confirmation | Present current target/draft and fee/consent terms; establish completed playback, then a separate final caller affirmation. Changed target, terms or draft invalidates that confirmation. |
| A-04: declared commit semantics | Standalone: fresh exact checks, one possible send and required post-write inspection under the accepted best-effort policy. Owning diary: atomic target revision, interval/patient uniqueness and exact receipt across every competing writer. Neither policy claims guarantees its mechanism lacks. |
| A-05: send and stop semantics | Current permission, policy and write stop checked before dispatch. Abort before send prevents mutation; after possible send remains uncertain. No blind retry, replacement-owner replay or automatic compensation follows uncertainty/conflict. |
| A-06: honest outcome and loss | Confirm only a clear successful response plus operation-specific exact inspection under best-effort, or an exact protected owner receipt under the atomic contract. Lost/mismatched responses remain unresolved. Later matching state may establish current facts, not original-writer attribution, fees or notifications. True processing loss and restart are exercised. |
| A-07: unresolved-work owner | Before an existing-patient appointment send, validate acknowledgment of a confirmed Cliniko-owned review request. Fresh-process discovery uses configured account/type alone, not lost local patient/marker data. Review is observation/human action, never a replacement mutation dispatcher. Approved staff owner, backup, cadence, acknowledgment, resolution, overdue/outage escalation are rehearsed. First-time intake uses the separately accepted D-18 caller-mediated loss contract, with separately acknowledged loss wording and no saved staff-request promise before a proven patient reference. |
| A-08: evidence and transport | Whole text/call, command, provider-race, loss/stop/privacy and isolated parallel E2Es on the reviewed source. Actual clinic acceptance is separate. Real media/fallback and speech quality remain independent telephone gates; text implementation needs no Twilio number. |

Patient-specific request-only is a separate capability requiring D-07's accepted durable Cliniko workflow. An instruction to contact the clinic or a generic alert is not a saved staff request. If the queue create is uncertain, no appointment mutation follows; a committed response-lost queue record remains human review work in Cliniko. Its absence cannot authorize retry.

## 3. Cancellation — first appointment activation candidate

Verify the current patient and one exact appointment's business/practitioner/type/start/end against the confirmed snapshot and approved fee terms. Send one occurrence cancellation with `apply_to_repeats=false` and no patient free-text note in the cancellation request. Under best-effort, a successful response plus exact cancelled read-back permits the declared receipt; changed targets or unreadable/mismatched results remain unresolved. A final-read/PATCH race can cancel a concurrently changed target: the clinic must explicitly accept this limitation.

C-LOCAL-34/48/49/50 and C-LIVE-35/41/42 cover the existing edge and synthetic/demo lifecycle. E2E-264 shows that a target moved after the pre-read can actually be cancelled; uncertainty wording does not undo it. The owning-diary conditional-target contract remains stronger.

Remaining release proof: actual clinic verifier/fees and accepted concurrency policy; acknowledged pre-send Cliniko review, lost-context discovery and staff workflow; real processing-loss/stop and standalone composition E2Es. Cancellation stays unavailable until these pass.

## 4. Booking — post-write conflict detection

Revalidate the exact patient, current approved business/practitioner/type, eligibility, interval/time zone, consent/policy and caller confirmation. A provisional offer is not reserved. Acknowledge the Cliniko review request before the one POST; match the returned patient/selection/time/marker and inspect the created appointment's conflicts before confirmation. Failed/conflicting inspection stays unresolved; no cancellation compensates it automatically. A detected conflict cannot later be silently upgraded because it clears.

E2E-266 adds bounded conflict inspection in the synthetic embedded host after creation and during exact observation. Demo C-LIVE-07/27 and synthetic E2E-264 show that two same-slot writes can succeed before conflicts are observed. A clear read cannot prevent another writer's later overlap. The accepted clinic policy must reflect that limit. An atomic owning diary still enforces practitioner intervals across locations at commit under E2E-265.

Remaining release proof: real current offer/eligibility authority, accepted conflict policy, Cliniko-owned review/recovery and standalone text whole-call/loss/parallel evidence. The existing synthetic host still requires its stronger offer attestation; a new standalone host must not pass a fabricated `exclusiveCommitPermitted=true` to bypass that interface. Booking stays unavailable pending its implementation.

## 5. Rescheduling — one in-place move

Bind exact current source, confirmed destination and approved terms. Recheck before one in-place PATCH, then observe exact new state and conflicts. Changed/unreadable/conflicting/lost results remain unresolved with no second PATCH, automatic revert or cancel/create. Best-effort accepts a competing source edit or destination booking between validation and mutation; it promises neither atomic source preservation nor destination exclusion. The owning diary provides those stronger protections in one transaction.

C-LOCAL-36/48/49/50 and C-LIVE-37/38/41/42 supply existing edge and synthetic/demo evidence. E2E-264 demonstrates two moves colliding before conflict inspection. E2E-265 separately proves the owning-diary mechanism. E2E-285/286 now add the standalone reviewed best-effort text host, final send/read authority callbacks, PostgreSQL/backup and actual sender-loss proofs with synthetic selection/fee/permission/mail/provider inputs. Concrete clinic source/destination authority and policy, admitted session/menu integration, actual approvals/staff witness and live provider/notification lifecycle remain open; production rescheduling stays unavailable. See [the move implementation and remaining gates](STANDALONE_CLINIKO_RESCHEDULING.md).

## 6. First-time patient creation

Require an approved transient draft, consent/privacy acceptance, patient/proxy authority, duplicate-search policy and one attempt. Duplicate/ambiguous candidates require review; no guessed merge or automatic delete follows. A created patient does not prove a booking or delivered task. Unknown creation is never replayed because a later search is empty or the process restarted.

Best-effort accepts cross-owner duplicate races; owning-host uniqueness remains a separate stronger contract. Existing C-LOCAL-42/43/44, C-LIVE-39/40 and E2E-264 cover bounded edges, creation-followed-by-booking-failure and independent duplicate creates.

A patient-linked recall cannot be acknowledged before a first-time patient exists. Therefore the appointment review protocol does not establish intake recovery. D-18 selects caller-mediated recovery: approved loss wording must be played and separately acknowledged before collection; an unknown create is never retried/merged/deleted automatically, and the caller contacts the clinic. A patient or saved staff request is not promised after response loss. Do not create a dummy patient or put a caller's draft into an unrelated patient chart to disguise this gap. Creation stays unavailable until its separate step-7 proof passes.

## 7. Cliniko-owned review and follow-up

The candidate is a dedicated approved recall type holding a confirmed request in Cliniko before the appointment write. Its saved envelope identifies location/account binding, operation, approved target/interval and policy references; patient association comes from Cliniko. The active call holds its send permit transiently. Restart recovery discovers pending records by configured account/type and does not dispatch an appointment mutation.

A recall is review context, not an atomic receipt, unique send fence, assignment or human-delivery proof. Duplicate/edited/malformed envelopes and current-state mismatches must surface for review. Presence does not distinguish never sent, committed, failed or unknown. Initially only staff close records after inspection; API `recalled` alone does not establish the protocol's acknowledgment or resolution.

C-LOCAL-39/52, C-LIVE-53 and E2E-228 supply existing create/marker and aggregate-pulse evidence. Harness-carried markers do not prove lost-context discovery. E2E-267 adds fresh-process account/type-only discovery against a synthetic provider after sender SIGKILL; actual database/backup privacy is checked. This is not live Cliniko persistence, staff acknowledgment or complete pre-send workflow integration. The actual report workflow must include every dedicated-type request: last-visited business filters may hide a request for another location. Pagination, account size/scan bounds, provider outages and aggregate-only escalation need proof. D-07 clinic acceptance remains required; patient-specific handoff/request-only stay unavailable.

## 8. Provider evidence and limits

The [official OpenAPI bundle](https://docs.api.cliniko.com/_bundle/openapi.json?download=), read again 2026-10-04, has unchanged SHA-256 `4c354b3cb3fb9cf7ca91b5dd408b78f62896c62b89d265ba3190e5d2bd03740c`. Its reviewed write operations do not establish conditional-version/idempotency headers, atomic overlap exclusion or reservation consumption. This is absence from the published contract, not proof an undocumented stronger primitive is impossible.

[Cancellation](https://docs.api.cliniko.com/openapi/individual-appointment/cancelindividualappointment-patch), [creation](https://docs.api.cliniko.com/openapi/individual-appointment/createindividualappointment-post), [update](https://docs.api.cliniko.com/openapi/individual-appointment/updateindividualappointment-patch), [conflict inspection](https://docs.api.cliniko.com/openapi/individual-appointment/getindividualappointmentconflicts-get) and [recalls](https://docs.api.cliniko.com/openapi/recall) supply the ordinary primitives. Cliniko documents a [manual recall report](https://help.cliniko.com/en/articles/8410284-set-up-patient-recalls); the proposed request-before-mutation use is an engineering design, not a provider-endorsed transaction protocol.

The [2015 maintainer response](https://github.com/redguava/cliniko-api/issues/108#issuecomment-157761727) historically explains accepted overlaps and post-create inspection. It is not a current guarantee or impossibility proof. C-LIVE-07/27 are separate demo observations. D-16 accepts best-effort limits explicitly; no successful finite demo or synthetic test substitutes for the remaining workflow and operation proofs.

## 9. Historical proof and remaining implementation

E2E-264 uses the actual TypeScript provider edges with an adversarial synthetic provider; its six deterministic counterexamples distinguish instance-local fencing from provider/host guarantees for all five write kinds. The cancellation case also crosses the existing embedded media/voice, confirmation, effect and reconciliation interfaces. These are local synthetic evidence, not real Cliniko race observations or carrier proof. Full-call evidence remains planned.

The initial focused command stopped at two new fixture type errors (missing cancellation reason on observation and widened consent literal). Correcting the fixtures preserved all assertions. The corrected typecheck and complete two-file run passed 20 checks with no failures/skips. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791017457002.log`.

Final local verification on registered source `b48ddab1453f695ea3bf19f9e400789f04bcf999` passed:

- `npm run build:availability-console`, `npm run typecheck` and `git diff --check`.
- `node --test --test-concurrency=4 test/cliniko/write-activation.test.ts test/cliniko/cancellation-write.test.ts test/cliniko/reschedule-write.test.ts test/cliniko/booking-write.test.ts test/cliniko/patient-intake.test.ts test/cliniko/recalls.test.ts test/voice/embedded-cliniko-appointment-change-host-call.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts`: 79 passed, zero failures/skips.
- A disposable PostgreSQL instance through `bash scripts/with-postgres.sh`, then `ABBY_LEDGER=postgres npm run db:migrate` and `node --test --test-concurrency=4 test/composition/cross-mode-appointment-proposals.test.ts test/composition/cross-mode-agent-conformance.test.ts test/storage/standalone-privacy-journey.test.ts`: eight passed, zero failures/skips, including actual database and backup privacy scans. These commands ran in the same exported PostgreSQL environment.
- `node scripts/ordered-node-e2e.mjs` with `concurrency=4` dispatched `write-activation`, `embedded-cliniko-appointment-change-host-call`, `cancellation-write` and `reschedule-write` test files in that order and its reverse; 41 passed in each order, zero failures/skips. The runner verified actual dispatch and successful completion of every file.

Logs: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791018340151.log` (registered/provider/PostgreSQL) and `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791018357819.log` (both controlled parallel orders). No runtime, dependency, migration, provider permission or storage change was required. This is local evidence; carrier, live-provider activation and deployment gates remain open.

Before any promotion, the operation owner records exact scope/account/business, policy and credential versions, reviewed declared write contract and its supporting evidence, expiry/revocation owner, source/fixture versions, exact positive/denied/failure/race tests, permitted storage/recovery and clinic approval. Recheck current versions at proposal and commit; refuse changed bindings. Import/cutover must establish the destination's own proofs and force unsupported capabilities off rather than copying a source approval. Notification suppression/ownership stays a separate required host contract.

Implementation order now follows D-16: establish Cliniko-owned lost-context discovery and accepted staff review, implement real caller authority and clinic policies, then complete cancellation, booking, rescheduling and first-time intake in order. Existing proofs remain bounded evidence, not permission. The current compositions stay disabled until their applicable gates pass.


## 10. Optional stronger provider guarantees

The [reference implementation trace](../docs/flows/cliniko-reference-write-trace.md) demonstrates a practical integration based on ordinary writes, delayed inspection, compensation and local durable queues/ledgers. We can implement and test known API behavior without a written guarantee. The questions below concern optional stronger atomic-target/interval and exact-receipt guarantees; the inspected reference paths do not establish them. Their local patient-specific persistence cannot be copied into strict standalone Abby.

These questions remain useful if a protected provider path becomes available; a written atomic contract is no longer a prerequisite for D-16 best-effort implementation. They are prepared for the owner/API provider; no message has been sent and no mutation is authorized by this section.

1. **Conditional cancellation/update:** Is there a supported request precondition tied to the exact confirmed appointment version or fields? Does its check occur atomically with the mutation, including a concurrent UI/API edit? What exact rejection proves no cancellation, move, fee or notification side effect occurred? A response `ETag` alone would not prove a mutation precondition.
2. **Atomic interval exclusion:** Is there a supported create/move operation or consumable reservation that rejects practitioner interval overlap against every UI/API writer, including other business locations, direct appointment writes and concurrent moves? Specify buffers, expiry, consumption, permitted overrides, error results and how a rejected move preserves its source. Hiding offered times or returning conflicts afterward is insufficient.
3. **Exact attempt/outcome:** Is there a documented idempotency/request identity contract, including scope, exact payload binding, concurrent owners, retention and receipt lookup after real processing loss? Distinguish committed, rejected, pending and unknown; document whether any absence ever proves that no mutation was sent or committed.
4. **Cliniko-owned recovery:** Under Abby's phone-to-patient-ID-only storage rule, how can another owner discover an unresolved patient request and recover its exact provider-owned attempt without an Abby action/marker store? Is there a supported Cliniko-owned review queue and acknowledgment/escalation contract? Harness-supplied keys and generic alerts cannot supply lost-context recovery.
5. **Create and downstream semantics:** What provider guarantees coordinate duplicate patient creates and duplicate recall requests? Which fees, confirmations, reminders, practitioner notifications or staff-work records are emitted by successful, rejected and repeated operations, and who owns suppression and uncertain-result review?

For a proposed guarantee, request its supported endpoint/version, exact request/response contract, all participating writer paths, exceptions/overrides, retention/recovery semantics and deployment limitations. Then add bounded authorized adversarial probes and whole-call proof for that contract. Do not enable a mode based only on a finite successful demo, an undocumented header or a provider marketing statement.

### First-time intake recovery follow-up

The [standalone first-time intake proposal](STANDALONE_CLINIKO_FIRST_TIME_INTAKE.md) records E2E-291 and actual demo rejection of omitted/null memo patient associations. The product owner selected caller-mediated loss recovery on 2026-10-04 (D-18); its implementation and actual clinic/authority/delivery proofs remain required before activation. Existing-patient appointment review remains mandatory.

### E2E-296 local first-time booking continuation

The admitted intake/booking composition now supplies the local same-call journey, original mailbox expiry and independent booking-permission checks, concrete public eligible offers, played ordinal selection, separate SAM booking affirmation, acknowledged full Cliniko review and one inspected best-effort send. Actual PostgreSQL aggregate budgets/table/backup checks and five parallel SIGKILL positions retain the patient and forbid fresh-owner replay. This is synthetic clinical approval/permission/mail/provider evidence. It does not satisfy actual clinic permission/consent/notification/staff witness, real delivery, current provider lifecycle or live voice activation.
