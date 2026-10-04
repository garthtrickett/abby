# Standalone Cliniko first-time intake

**Status:** step-7 research, provider-edge hardening, public clinic policy checks and reviewable failure-contract proposal. Production caller intake stays unavailable. D-16 accepted best-effort concurrency limits; it did not approve losing an intake request after process loss. No exception to strict patient-data persistence is assumed. Real email delivery is deferred.

## 1. Existing evidence and unresolved requirement

The patient-create edge and transient draft authority already exist. C-LIVE-39 proves a disconnected synthetic patient lifecycle, duplicate/ambiguous rejection, consent revocation and response loss without resend in the demo account. C-LIVE-40 proves embedded synthetic voice intake followed by a rejected booking. Neither establishes standalone pre-patient recovery or accepted prospective-patient authority.

Existing-patient booking, cancellation and rescheduling acknowledge a patient-linked Cliniko recall before the appointment send. An intake request cannot use that ordering: the patient may not yet exist, and the patient-create response may be lost. Abby may not durably store the draft, attempt marker, consent or outcome under D-06/D-11/D-12/D-16. A replacement process cannot reconstruct this lost request from its database.

The memo candidate does not have a documented patient-less create contract. The current OpenAPI body lacks required-field annotations, but the [official legacy communication reference](https://github.com/redguava/cliniko-api/blob/main/sections/communications.md#permitted-memo-communication-properties) explicitly requires `patient_id` on create. The [current API](https://docs.api.cliniko.com/openapi/communication/creatememocommunication-post) describes an internal memo, not a sent message. The [staff instructions](https://help.cliniko.com/en/articles/2445269-record-communication-notes) begin from a patient's page. None proves a supported pre-patient queue or an accepted staff process.

`scripts/probe-cliniko-prepatient-memo.ts` checks omitted and null patient associations against the owner-designated demo account, with only synthetic research content. It never creates patients, appointments or a staff task. A fresh status/cleanup owner scans configured account memo records without a remembered response ID/marker. It is research, not an intake adapter or authorization source. Only exact owned synthetic records may be archived; uncertain or edited records stop cleanup. A 422 without a patient-field error does not prove the patient requirement. C-LIVE-55 records actual demo rejection of both omitted and null associations, followed by zero active research memos. C-LOCAL-71 records source-matched 42-case parallel and 18-case forward/reverse safety/regression gates. Exact source, commands and limitations are in the [evidence log](../phase-0/CLINIKO_EVIDENCE.md#c-local-71--pre-patient-memo-research-and-intake-recovery-proposal).

This finding rules out treating a memo as established pre-patient recovery. It does not claim every possible Cliniko workflow has been disproved. Another supported pre-patient workflow would need separate API, staff visibility, acknowledgment, complete discovery, outage and process-loss evidence.

## 2. Proposed decision requiring the product owner's answer

**Recommendation:** allow a separately named caller-mediated recovery contract for first-time standalone intake, while retaining Cliniko-owned pre-send review for every subsequent appointment write. This is a material change to the recovery promise and needs explicit product selection before building the caller path. Clinic consent/policies and activation would still need their own approval.

The alternative is to require a proven Cliniko-owned pre-patient queue, leaving automatic first-time intake unavailable while that is established. Merely enabling SET-005 cannot choose either contract.

The proposed contract is deliberately concrete:

1. Before collecting an approved draft, explain the privacy policy and that a connection/process failure can leave a patient record without an appointment or saved staff request. The caller must contact the clinic to resolve uncertainty. Require separate acknowledgment of this limitation; do not bury it in general privacy consent.
2. Prepare and present the exact approved patient details through the trusted owner. Receive completed playback and a separate affirmation before one possible patient POST. No provider identifier, code, draft or authority reference is supplied by a model as permission.
3. A clear successful create plus exact provider inspection may issue a transient patient reference. A lost/malformed response or failed inspection means patient creation is unconfirmed. Never replay, merge or delete automatically.
4. If the process dies before acknowledged create, no staff request is promised and no process replacement resumes the intake. The independent provider fallback handles the call where available. A generic alert contains no patient/request content and cannot replace a lost patient-specific queue.
5. If a patient reference is proven, require an acknowledged Cliniko-owned recall before any appointment mutation, using the existing best-effort appointment contract. New intake authority must not be silently promoted into existing-patient action authority: its dedicated operation-bound grant needs independent current permission and verification rules.
6. Intake success and appointment success are separate caller statements and receipts. A rejected/uncertain booking retains the patient in Cliniko and never claims an appointment or staff receipt that has not been proven. A failed recall blocks the appointment send; staff review is claimed only after exact acknowledgment, not just after patient creation.

This contract accepts that an unknown patient create might commit without discoverable Abby-owned staff work. It does not turn later matching patient data into proof of attribution or authority. Its name must remain distinct from the existing Cliniko-owned recovery contract in policies, host declarations, effective capabilities and documentation.

## 3. Proposed supported intake scope

These restrictions are proposal inputs, not currently approved clinic rules:

- Self-registration by an adult, with clinic-supplied minimum age and required fields. Proxy, guardian, minor and third-party registrations use the approved clinic fallback until separately implemented and approved.
- Trusted private collection of first name, last name, date of birth, email and the admitted caller phone. No intake chart notes, medical history, treatment notes or free-text staff messages.
- Prospective-patient email OTP proves control of the supplied mailbox only. It does not prove legal identity, DOB, adult status, membership of a pre-existing patient record or the caller's right to act for someone else. Clinical identity requirements remain a clinic policy.
- Any existing or ambiguous candidate blocks creation and switches to an independently verified existing-patient flow or clinic fallback. No record is selected or disclosed from an unverified email/DOB match.
- Public approval binds clinic/location/business/API-user credential, intake setting/version, admission/session/lease, privacy/consent/required-field/duplicate policies, terms and this failure contract. Current permission and write stop are checked before reads and immediately before any possible send.
- A completed intake must not issue booking permission by itself. New-patient offers, practitioner/type eligibility, recall workflow, consent and notification behavior require explicit supported policies and independent action approval.
- All patient draft, consent, OTP, proof, provider receipt and proposed booking state remains transient in standalone Abby. Only the permitted phone-to-Cliniko-patient-ID link may later enter the existing validated index workflow; no additional patient fields or recovery identifiers become durable.

## 4. Required implementation and tests after a contract is selected

| Work | Completion evidence |
| --- | --- |
| Exact clinic policies | Authenticated public policy/version capture and revalidation; default/enable/disable/next-call, location and admin/credential isolation; unsupported contract never activates intake |
| Private collection and caller authority | Actual admitted owner; OTP delivery stub now and real mailbox later; no patient/code/proof leakage into agent tool results or logs; draft corrections revoke old confirmation/proof; expiry, denial, revocation, age/proxy/candidate cases |
| Cliniko patient create | Actual shared API-user request budget for duplicate check, one POST and bounded exact response/read-back; exact names/email/DOB/phone/privacy/state; changed request/policy/consent, foreign scope, rate limit, malformed and noncooperative IO tests |
| SAM and agent journey | Existing proposal-only command accepts trusted references; actual private owner preparation, exact played confirmation and separate affirmation; duplicate/interrupted/stale turns cannot dispatch; caller hears truthful patient and appointment outcomes |
| Partial success | Actual patient edge and subsequent reviewed booking composition; booking denial/uncertainty, failed review acknowledgment and owner loss leave patient intact, no appointment resend/compensation and no invented follow-up |
| Replacement behavior | Kill at before/during/after possible patient send; discard original process context; fresh owner never retries original intake or uses a candidate as proof; test the selected loss contract honestly |
| Privacy and isolation | Real disposable PostgreSQL aggregate budgets/index, table and backup canaries for draft/DOB/email/code/proof/attempt/receipt; parallel isolated journeys and controlled forward/reverse orders |
| Live and voice activation | Guarded synthetic demo-provider lifecycle and cleanup; accepted clinic authority/consent/recovery policies, actual email delivery and staff workflow; recorded/generated speech and eventual carrier evidence remain distinct gates |

E2E-292 hardens the existing provider edge independently of D-18: explicit country calling code, exact single phone/type response evidence, separate same-patient GET with matching draft/privacy/active state, one operation deadline and consumer signal through authority/search/budget/create/read-back, and immediate disposal of held transient authority work. An interrupted pre-send wait denies dispatch; after a possible create the result stays uncertain and never retries or compensates. Actual PostgreSQL shared-budget and backup canaries cover this seam. This does not choose a failure contract, approve intake consent, provide prospective-patient authority or complete the caller composition.

## 5. Function ownership and carryover

- `ClinikoPatientIntakeEdge.createOnce(request, { signal?, timeoutMs? })` owns provider duplicate search, one possible create and independent exact receipt read-back. Its configured country calling code makes phone comparison explicit; a normalizing match is no identity proof. The default 15-second deadline covers the whole operation and a possible send consumes the process-local attempt. It returns only a patient reference, a typed pre-send failure, a candidate condition or uncertainty.
- `OwnerFileIntakePolicy.capture(config, signal?)` captures an exact owner-only public approval against current clinic-admin membership and pinned scope/provider/setting versions. `current(scope, signal?)` revalidates its file digest, administrator and effective window; `checkDraft(query, signal?)` privately checks exact required fields, self-registration, clinic-local minimum age (explicit March 1 leap-day rule), admitted phone and both recorded terms versions. It returns only public terms/revision/expiry or a typed denial. The trusted owner supplies the captured raw intake flag/version; normal setting edits apply to subsequent calls, while public approval or administrator changes revoke captured use. Default reads are bounded to five seconds (maximum configured thirty); abandonment cannot publish a late policy. This module is needed under either possible recovery contract and grants no patient creation authority.
- `TransientIntakeAuthority.prepare(draftRef, consentRef, authorityRef)` / `attest(request, phase, signal?)` bind exact approved draft, consent and authority to one transient attempt. It never persists a patient draft or creates a staff request.
- The future admitted owner captures public clinic policy and trusted intake/verification sources, owns private selections/proofs and closes all transient state together. It composes the edge and SAM without a second action-decision loop.
- The portable core accepts a host-supported intake capability and separate operation receipts. Cliniko-only loss semantics stay in the standalone adapter/policy. An acquisition host may supply its existing patient master, durable approved intake queue and atomic receipts without changing the portable SAM transition.
- A clinic-owned queue, if later established, would be another supported contract with its own proof. It cannot retroactively repair missing requests or silently change active calls.

## 6. Completion boundary

Step 7 is incomplete until a failure contract is explicitly selected, implemented and tested, and its actual authority/clinic/provider/workflow gates pass. Research, synthetic E2Es, an enabled raw setting, or a created patient from the disconnected demo probe are insufficient. The original nine-step objective remains active.

### Intake edge hardening boundary

The candidate reader accepts an optional consumer signal on exact email/DOB search; stopped budget or transport waits cannot start a late lookup. The transient intake authority projects approved draft fields instead of spreading runtime host data over call/scope/consent bindings, captures attestation inputs before waits and aborts its lifetime on disposal. `awaitUntilAbort` bounds noncooperative waits without granting cancellation of an already possible provider send. These are process-local controls; they do not establish cross-process uniqueness, Cliniko-owned pre-patient recovery or physical carrier behavior.

The frozen E2E-292 gate passed 136 parallel checks across 22 files and 20 in each controlled order, all without failures or skips, including actual migrated PostgreSQL/shared-budget and backup canaries. [C-LOCAL-72](../phase-0/CLINIKO_EVIDENCE.md#c-local-72--exact-intake-phone-receipt-independent-read-back-and-abandoned-work) records the exact source/commands and the retained missing-asset failure. No current live patient lifecycle, caller permission or D-18 approval is claimed.

### Public policy boundary — E2E-293

The policy schema rejects private fields and a `recoveryContract`; it does not choose the unresolved D-18 option. The supported public schema declares exact names/email/DOB/admitted phone/type, adult self-registration, no minors or representatives, prospective email OTP, independent host permission and duplicate-candidate denial. These are locally tested schema restrictions, not real clinic approval. An eventual admitted owner must additionally bind the selected failure contract, call/session/lease, observed consent and email proof, current permission, write stop and played SAM affirmation before a create. Passing `checkDraft` validates trusted recorded booleans/version inputs; it neither observes the caller accepting terms nor proves mailbox control.

Memory and actual disposable PostgreSQL tests cover disabled baseline, enable, next-call disable, captured active policy, re-enable requiring the matching new public approval, foreign scopes and public-only audit. They prove that raw enabled settings plus valid public eligibility still leave standalone intake unavailable. Database and backup scans exclude the private draft. No patient/caller route, migration, external delivery or provider mutation is added. Real email delivery remains deferred; first-time caller composition and actual activation remain incomplete.

[C-LOCAL-73](../phase-0/CLINIKO_EVIDENCE.md#c-local-73--public-clinic-intake-policy-without-patient-create-authority) records the frozen source, 75 passing parallel regressions and 10 passing cases in each verified dispatch order, with zero failures or skips.
