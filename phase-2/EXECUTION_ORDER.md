# Abby execution order

**Status:** Proposed sequence, documentation only. **Date:** 16 October 2026.

**Execution:** The owner subsequently instructed work through this order. See [current progress and evidence](EXECUTION_PROGRESS.md). That instruction activates the planned engineering; clinic/provider acceptance, deployment and Aeva removal retain their separate requirements below.

Preserve access to the useful Aeva material now. For Abby engineering, deliver the provider acknowledged booking change first, requalify the affected receptionist flows, finish the remaining earlier-gap and class work, then build payments, outbound and approved writeback in that order. Apply the Aeva lessons inside those changes rather than creating a separate Aeva feature-parity project.

## The three source documents

| Document | Role in execution |
| --- | --- |
| [13-gap Cliniko integration plan](THIRTEEN_GAP_IMPLEMENTATION.md) | Master requirements and engineering history. All thirteen gaps remain in scope; historical local passes do not establish current completion or activation. |
| [Provider acknowledged booking plan](PROVIDER_ACKNOWLEDGED_BOOKING_PLAN.md) | Detailed prerequisite for changing individual and native class booking success. Its four implementation steps and verification matrix govern the booking stages below. |
| [Aeva reuse audit](AEVA_TO_ABBY_REUSE_AUDIT.md) | Source references, acceptance scenarios and optional extensions. R01–R28 are recommendations with different scopes, not twenty-eight automatically approved features. |

This document orders those plans; it does not replace their detailed contracts or authorize implementation, provider actions, deployment or deletion. The booking change still needs the separate implementation go-ahead recorded in its plan. Existing activation of the thirteen-gap roadmap remains recorded there; this sequencing document does not invent another approval for already authorized work. Any conflicting contract or material scope change must be resolved explicitly before the affected implementation.

## Planned order

### 1 Preserve Aeva source access before local deletion

Follow the audit's [preservation checklist](AEVA_TO_ABBY_REUSE_AUDIT.md#preserve-before-removing-the-local-source). Verify independent retrieval of the exact audited source and tests, inventory dirty worktrees and local-only work, and retain the selected material in an approved destination. Keep these four planning documents independently recoverable too. A local commit or GitHub link alone is insufficient.

The audit used Aeva `34a642be8da7884b924eb02e7ccae731bd428276`; remote retrieval was not verified. Its summaries preserve lessons, not the whole source. Avoid placing a wholesale Aeva archive, credentials or patient material in Abby.

**Exit:** The operator has a concrete preservation inventory and verified recovery evidence before deciding to delete anything. Source removal, service shutdown and credential/data-retention decisions remain separate owner actions. Unavailable remote access blocks deletion readiness; it need not block independent Abby engineering.

### 2 Establish the actual Abby delivery baseline

Before the first implementation, inspect current main, the integrated candidate and applicable repository instructions. The source reviewed by the three plans was Abby `4e19e1783e2324480c9e0d0923eeaf825e04692e`, with main ancestor `9a29e51e7f7e0a765db7674c6c75ff2087260473`. These are historical anchors, not permission to land every intervening change together.

Identify the owned, reviewable changes needed from that candidate, their actual publication state, and the current failures or missing qualification. The roadmap's final entries contain unresolved whole-suite results; do not convert focused historical passes into a clean release claim. Diagnose relevant failures and record independent blockers without silently widening the patch.

**Exit:** Exact base/head, patch ownership, applicable approvals and the narrow validation route are recorded. Start isolated implementation branches from current main, bringing in prerequisites through the repository's review process. No deployment is implied.

### 3 Define the booking contract and exact individual receipt

Execute [booking step 1](PROVIDER_ACKNOWLEDGED_BOOKING_PLAN.md#step-1-define-the-contract-and-exact-individual-receipt). Record the scoped decision and add exact request/response matching, including the confirmed end time and native identity/status fields. Keep proposed documentation distinct from delivered behaviour.

**Exit:** Valid and invalid acknowledgements have meaningful tests, the owning-diary contract remains intact, and the existing host success gate has not been replaced before the receipt checks exist.

### 4 Deliver provider acknowledged individual booking

Execute [booking step 2](PROVIDER_ACKNOWLEDGED_BOOKING_PLAN.md#step-2-implement-final-availability-and-acknowledgement-based-individual-booking). Finish patient, permission, review, policy and quota preparation before the final exact availability observation, then send once. Cover both online and roster readers through actual transport dispatch, including booking after separately proven registration.

Recognize only the exact validated acknowledgement as success. Later observations, reporting or speech failures cannot erase that success. An ambiguous dispatched write remains unknown and cannot be blindly replayed. Preserve Cliniko-owned pre-send review and independent recovery discovery; introduce no local patient-bearing attempt ledger.

**Exit:** Ordering, response-loss, deadline/abort, duplicate and observer-failure cases pass through the host, reviewed-send wrapper and effect worker. Shared cancellation, reschedule, correction and resend contracts retain their existing guarantees.

### 5 Deliver provider acknowledged native class creation

Execute [booking step 3](PROVIDER_ACKNOWLEDGED_BOOKING_PLAN.md#step-3-apply-the-contract-to-native-class-booking). Apply the receipt policy to exact attendee creation, including an already approved pass. Finish entitlement/history/quota preparation before final occurrence/capacity observation. Preserve class-specific permission and played consent.

**Exit:** Exact attendee/patient/occurrence/case binding, capacity races and entitlement races have coverage. No atomic capacity or financial guarantee is invented. Class cancellation, movement and pass relinking retain their operation-specific contracts; successful replacement creation alone does not complete a move.

### 6 Requalify composed flows and address earlier-gap engineering

Execute [booking step 4](PROVIDER_ACKNOWLEDGED_BOOKING_PLAN.md#step-4-verify-composed-flows-and-finish-documentation) and its [verification requirements](PROVIDER_ACKNOWLEDGED_BOOKING_PLAN.md#required-verification). Requalify actual admitted caller flows, process-loss recovery, privacy, result readers and compiled serving paths. Revise affected documentation with the delivered runtime.

Check every earlier roadmap gap against the current combined candidate. Preserve completed engineering and make a concrete list of remaining work:

| Gap | Work to qualify or finish |
| --- | --- |
| 1 | Running receptionist composition and exact-head qualification of booking, enquiry, cancellation, rescheduling and intake. |
| 2 | Verification/permission integration, exact subject authority and auth regressions. Keep clinic policy and real delivery acceptance explicit. |
| 3 | Recovery/operator routes, message outcomes and monitoring ownership. Evaluate independent missing-completion detection using only permitted operational data. |
| 4 | Repeated synthetic speech, safety and usable public-transport qualification. Retain failing noisy-speech evidence and thresholds; carrier work remains deferred. |
| 5 | Approved catalogue, duration, location and initial/follow-up rules; incomplete refresh must preserve approvals. |
| 6 | Final availability for longer searches and explicitly approved offline/recurring calendars, including complete-source and bounds refusal. |
| 7 | Practitioner-change regression, retained original choice, explicit alternatives and operation-specific reschedule semantics. |
| 8 | Registration-to-booking separation, corrections, resends and recovery-host/operator integration. Record unsupported field adapters against actual requirements. |
| 9 | Independent authority and per-action results for approved self/related-person combinations. Record remaining cohort/operation coverage; never infer general representative authority. |

Resolve prerequisites before the later capability that needs them. Work through remaining independent engineering in roadmap order; externally blocked acceptance does not stop unrelated no-number implementation. Gap 4's speech work can continue alongside the capability sequence, but its safety gate remains required for the relevant voice activation. Do not turn this stage into a requirement to rebuild all existing features or implement every reuse suggestion.

**Exit:** Booking composition and earlier engineering prerequisites are qualified. Finish remaining independent gaps 1–9 patches in roadmap order before new later-gap features; record explicit blockers where a dependency is unavailable and continue unrelated work. Gaps 1–9 retain honest current evidence and acceptance limits. Their clinic, real-mail, acoustic and deployment gates are not marked complete by source changes.

### 7 Finish gap 10 class and pass workflows

Return to the [gap 10 staged quota and verifier work](THIRTEEN_GAP_IMPLEMENTATION.md#gap10-private-verifier-succession-for-native-stages-e2e-418). Build on the existing movement, compensation and provider-owned recovery machinery.

Finish the staged caller/SAM presentation, receipt and renewed-consent route, operator resolution integration, complete cost/quota admission and the required mixed catalogue, correction and no-pass/pass combinations. Exercise renewed verification and bounded stages across quota windows through actual serving. Preserve original/replacement truth and remaining recovery obligations after partial movement.

**Exit:** The required class booking/cancellation/movement journeys have current composed, concurrent and recovery evidence, with explicit operator acceptance limits. Pass counters or native associations do not prove financial provisioning, paid membership or money movement. Any required financial dependency stays recorded for gap 11 rather than being declared delivered here.

### 8 Build gap 11 payments and expiry

Use the roadmap's [gap 11 requirements](THIRTEEN_GAP_IMPLEMENTATION.md#requirements-and-evidence-needed) with audit [R18](AEVA_TO_ABBY_REUSE_AUDIT.md#r18-separate-payment-truth-from-appointment-and-delivery-truth) and [R19](AEVA_TO_ABBY_REUSE_AUDIT.md#r19-use-aeva-payment-races-as-adversarial-requirements).

Stripe and dedicated Cliniko financial reviews are owner-selected. Qualify the
concrete clinic record and permission contracts first, then implement exact action/account/amount/currency binding, authenticated and idempotent events, link delivery, receipts and independently authorized expiry. Keep payment, appointment, delivery and receipt outcomes distinct. Cover duplicate/out-of-order events and payment-versus-expiry races. No invented reservation, automatic restoration, refund or financial coverage promise.

If a required receipt needs native attachment support, bring forward only that approved [R22](AEVA_TO_ABBY_REUSE_AUDIT.md#r22-give-notes-and-attachments-distinct-permissions-and-receipts) dependency here, under its own exact-target/storage contract. Do not wait for all gap 13 work or quietly add general clinical writeback.

**Exit:** Complete synthetic payment/expiry journeys and failure recovery are demonstrated through the actual host. Real payment, sender and clinic acceptance remain distinct. Keep patient-bearing payment state out of standalone local persistence.

### 9 Build gap 12 outbound and sick-day workflows

Use the roadmap's [gap 12 requirements](THIRTEEN_GAP_IMPLEMENTATION.md#requirements-and-evidence-needed) with audit [R20](AEVA_TO_ABBY_REUSE_AUDIT.md#r20-build-outbound-campaigns-separately-from-recall-requests) and [R21](AEVA_TO_ABBY_REUSE_AUDIT.md#r21-pin-the-exact-sick-day-or-callback-appointment-end-to-end).

The owner selected separate clinic-approved Cliniko contact reviews for voice consent and opt-out/DNC, distinct from financial reviews; marketing flags are not voice consent. Authenticated provider opt-outs at the dialled number may automatically write dedicated Cliniko DNC decisions under clinic-approved policy; future calls stay blocked and reconsent requires clinic approval. Qualify that concrete source and its current grants. Define approved audience and contact policy, then build opt-out, quiet-hours/timezone handling, scheduling, cancellation, capacity limits and per-action recovery. Bind each callback/sick-day action to the exact fresh appointment and independently verified authority. Existing recall requests do not establish campaign support; a shared phone or campaign record does not establish patient permission.

**Exit:** Patient-free end-to-end campaign/sick-day cases cover stale targets, changed appointments, opt-out, duplicate delivery and interruption. Actual outbound contact and carrier admission require their applicable acceptance; do not add a local patient-bearing campaign database.

### 10 Build gap 13 approved communication and document writeback

Use the roadmap's [gap 13 requirements](THIRTEEN_GAP_IMPLEMENTATION.md#requirements-and-evidence-needed) with audit [R08](AEVA_TO_ABBY_REUSE_AUDIT.md#r08-generate-any-future-prose-from-trusted-outcomes) and [R22](AEVA_TO_ABBY_REUSE_AUDIT.md#r22-give-notes-and-attachments-distinct-permissions-and-receipts).

Establish clinic-owned content, storage, exact subject/target and permission separately for patient memos, individual notes, shared-class records and attachments. Derive any permitted prose from trusted outcomes. Preserve concurrency, partial upload/orphan and ambiguous-write boundaries; neither a released claim nor a transport response permits blind replay.

**Exit:** Approved writeback types have actual host evidence, exact receipts and safe failure/recovery cases. No transcript-based clinical inference, cross-patient disclosure, unsafe shared-class note or local private queue is introduced. Requalify any receipt attachment brought forward in stage 8.

### 11 Complete combined qualification and activation acceptance

Every capability stage needs focused checks before publication and the required review/CI before landing, following the repository process. After the core sequence, run the appropriate full regression against the actual combined source/build candidate, including real PostgreSQL/process/backup privacy evidence where required. Record exact commands, completed results, skipped/killed work, unresolved failures and the manual-test proposal. Historical passes cannot satisfy this gate.

Keep external readiness visible from stage 2 onward: actual clinic verification/consent/fees policy, deploying-host permission sources, sender/mailbox delivery, staff recovery ownership, deployed monitoring receiver and fresh work evidence, native-provider acceptance, model/acoustic/public-route qualification and any later authorized carrier tests. Obtain these as dependencies become available; stage 11 is the final reconciliation, not the first time to investigate them. Existing real-email and Twilio deferrals remain in force until changed by their owner.

**Exit:** Each of the thirteen gaps has current engineering evidence and an explicit acceptance status. Deployment, configuration/content activation and human acceptance are separately evidenced before relevant patient traffic. If an external gate remains blocked, report engineering progress and that blocked acceptance accurately; do not declare the entire integration complete.

## Where every Aeva recommendation belongs

These assignments keep the audit actionable without adding a second backlog ahead of gap 10. Preserve existing invariants wherever their modules change; adopt a new feature only when it satisfies an actual requirement and its applicable decision is settled.

| Audit items | Placement |
| --- | --- |
| R01 | Evaluate within gap 3 at stage 6. Independent completion coverage must fit permitted metadata; report any coverage limit rather than creating a private ledger. |
| R02 | Gaps 5–7 at stage 6 when extending approved alternatives. |
| R03, R04, R05, R06 | Regression scenarios across booking stages 3–6 and later changed flows: exact corrections, separate subjects, unknown versus empty reads, independent action/observer outcomes. |
| R07 | Later, only if a real batched model adapter is selected. |
| R08 | Stage 10, and any earlier approved outcome-generated communication. |
| R09, R10 | Setup/readiness and approved public knowledge in gaps 1–5 at stage 6 where evidence identifies a missing capability. |
| R11 | Start a small source-bound product/operator reference with delivered booking changes; maintain it with stages 6–11. No support chatbot prerequisite. |
| R12 | Later, if visible AI support responses are built; it does not replace gap 4 speech testing. |
| R13 | Optional reviewed public vocabulary work within gap 4; no speech-gate bypass. |
| R14 | Existing verification/auth regression when gaps 2–3 change; preserve Abby's login stack. |
| R15, R16 | Gaps 5–6 catalogue maintenance and existing setup/reconnect paths at stage 6 where needed. No OAuth/provider expansion implied. |
| R17 | Check operation capability boundaries in each changed provider path. Additional providers require a separate scope decision. |
| R18, R19 | Gap 11 at stage 8. |
| R20, R21 | Gap 12 at stage 9. |
| R22 | Gap 13 at stage 10; only a necessary approved receipt dependency moves to stage 8. |
| R23, R24, R25 | Relevant monitoring, transaction and exact-release evidence in every affected patch; close remaining gap 3/activation needs at stages 6 and 11. No infrastructure rewrite prerequisite. |
| R26, R27, R28 | Later, after core work and a separate product decision: website import, commercial lifecycle, marketing or additional channels. |

## Delivery and refinement notes

Use one coherent reviewable patch at a time, with focused semantic tests, actual serving-path evidence and the applicable repository checks. Apply the simplest shared flow and keep native translation inside its adapter. Retain the standalone phone-to-Cliniko-ID-only storage boundary and the distinct authorized storage contract of an embedded owning host.

Refine the detailed gap 11–13 specifications immediately before their implementations using the corresponding audit acceptance scenarios and then-current source. Do not treat this order as a settled payment, campaign or clinical-content product specification. Update the master roadmap's evidence as work lands; keep this document focused on dependencies and sequencing.

This sequence was checked against the three documents for booking-step order, all thirteen gaps, all twenty-eight reuse items, operation-specific recovery, deferred external acceptance and source preservation. It records proposed work; it claims no newly executed product tests, implementation or deletion readiness.

### Shared-host execution

For future local jobs, follow the operator's live host policy at
`/home/gust/infra/docs/shared-compute.md`. Independent bounded jobs may overlap
when actual CPU/RAM headroom and file/database isolation permit. Historical
exclusive-slot notes are not current resource authority. Preserve source pins,
test concurrency/deadlines and real shared-file/database exclusions.
