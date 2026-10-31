# Karen designs and lessons to preserve for Abby

**Local non-patient guardian qualification, 31 October 2026:** The owner-selected
optional route now composes a distinct registered-contact caller proof, separate
current clinic patient/action authority and an independently verified patient
with the existing enquiry/book/cancel/reschedule owners. All 203 source controls,
whole strict types, 757 actual serving outputs and seven new emitted signed
SQL/privacy/full-restore cases pass. Three unchanged native-patient guardian
shared-email cases also pass on these outputs. Missing/revoked approvals cannot
switch methods or grant patient access. Final review, own-head/main delivery,
production record provisioning and clinic/provider acceptance remain separate;
all eleven stages, thirteen gaps and twenty-eight reuse placements remain.
See [contracts, evidence and limits](CLINIKO_GUARDIAN_RECORDS.md).

**Source navigation:** Karen source links in this document open the current owner-supplied local reference snapshot. Recorded inspection dates and historical commit IDs remain historical evidence; the uploaded snapshot has no verified commit identity and is not asserted to match those revisions. A historical path absent from the upload links to the reference root for investigation.

**Status:** Proposed reuse inventory, documentation only. **Audit date:** 16 October 2026.

Keep the [13-gap Cliniko integration plan](THIRTEEN_GAP_IMPLEMENTATION.md) as Abby's master roadmap and the [provider acknowledged booking plan](PROVIDER_ACKNOWLEDGED_BOOKING_PLAN.md) as its booking prerequisite. This third document preserves additional designs, failure scenarios and reference locations worth retaining before removing Karen's local checkout. It supplements those plans; it neither replaces them nor authorizes implementation or deletion.

The most useful transfers are concrete acceptance scenarios and small designs for unfinished financial/outbound/writeback work, independent checks for disappeared calls, explicit availability alternatives, setup diagnostics, and source-bound operational knowledge. Abby already has substantial verification, confirmation, multi-person, privacy, lease and notification machinery. Reuse that machinery and extend its tests rather than rebuilding it in Karen's shape.

## Current owner-supplied reference, 19 October 2026

The latest snapshot supplied by the owner is available at **`/home/gust/code/karen-website-dev`**, beside `/home/gust/code/abby`. Current and future agents should search this copy for existing implementations and tests whenever unsure how to solve a workflow or integration problem. Treat Karen as a likely source of an existing solution, then adapt and verify it under Abby's architecture, privacy, permission and recovery contracts.

The source archive is available through the local alias `/home/gust/code/karen-website-dev.zip`, SHA-256 `ceeeda427e248fc4bb68e0f10788867df9de5cf5462d98b45d0234079fc14a4e`. Extraction verified 5,492 regular files against archive size/CRC and preserved two internal symbolic links. No `.git` metadata remains; the archive contained none. This owner-supplied snapshot has no verified commit identity and must not be attributed to the historical `34a642be...` audit below. Paths in this new section refer to the uploaded snapshot; the original numbered recommendations retain their pinned historical source unless individually rechecked.

Start with `docs/flows/`, including `outbound-campaigns.md` and `vapi-assistant-lifecycle.md`; inspect the corresponding implementation and tests under `server/src/`. For the current outbound work, useful entry points include `services/pms/outboundPmsAdapter.ts`, `services/ob/obOutboundLaunchService.ts`, `services/outbound/vapiOutboundService.ts`, and `services/postcall/outboundDispatchContext.ts`, relative to `server/src/`. These are reference locations, not new claims of Abby implementation or successful clinic/provider acceptance.

## Source and evidence boundaries

- Karen: locally cached `origin/dev` at `34a642be8da7884b924eb02e7ccae731bd428276` in the Karen reference repository. All Karen paths below refer to this immutable tree unless explicitly marked otherwise. The tree contains 5,431 tracked paths; this was a broad domain survey followed by selected writer-to-reader and test inspection, not a line-by-line certification of the entire repository.
- Abby: integrated runtime at `4e19e1783e2324480c9e0d0923eeaf825e04692e`, plus the booking-plan commit `69b5db882671ef68581dd9c3372a48cf683e3dd1`. Existing implementation and qualification limits remain those recorded in its roadmap. The older root [Karen gap analysis](../KAREN_ABBY_CORE_CLINIKO_GAP_ANALYSIS.md) is a historical baseline, not today's missing-feature list.
- Source paths and test witnesses show designs and executable assertions inspected. They do not prove tests passed here, that a feature is deployed, or that a real clinic approved it. This audit runs no provider calls or product tests.
- GitHub retrieval could not be verified: shell Git lacked usable authentication, and the connected GitHub tool returned 404 for the pinned Karen file. Links identify exact source; they are not a verified backup. The final preservation checks below remain necessary before local removal.
- The dirty Karen root checkout, index conflicts, untracked notes and other worktrees are excluded as executable evidence. They require their own preservation inventory; they are not made safe to delete by this document.

Unprefixed Karen `services/`, `controllers/` and `jobs/` paths are under `server/src/`; test witnesses are under `server/src/__tests__/` unless their full path says otherwise. Abby paths start at the Abby repository root. The short flow traces below describe the pinned source; each **Acceptance** paragraph states requirements for adapting it to Abby, not tests executed in this audit.

## Placement in the existing work

Use **extend** for a concrete addition to an existing roadmap gap, **preserve** for an invariant or regression scenario Abby already implements, and **later** for a useful product expansion requiring its own decision. These labels describe transfer value, not completion status or permission.

| Area | Placement | Recommendation |
| --- | --- | --- |
| Lost completion detection | Extend gap 3 | Compare independent carrier/admission evidence with terminal accounting, using permitted operational data. |
| Alternative offers | Extend gaps 5–7 | Preserve the original choice and explain exactly why a substitute is offered. |
| Corrections, subjects and partial results | Preserve gaps 1, 2, 6, 8, 9 | Import adversarial scenarios, not Karen's inference and reconstruction algorithms. |
| Multi-call tool protocol | Later model-adapter need | Preserve IDs, per-result errors and shared deadlines only if Abby adds a batched transport. |
| Pricing, deposits, outbound and writeback | Extend gaps 11–13 | Retain concrete flows and failure distinctions while redesigning storage, authority and retries for Abby. |
| Setup, knowledge and operations | Extend existing foundations | Derive useful diagnostics and freshness evidence from the actual configured host. |
| Customer lifecycle and additional channels | Later | Reuse selected patterns only if Abby chooses to own those products. |

## Call behaviour and reliability

### R01 Independently detect calls missing their completion path

**Extend gap 3.** Karen's `server/src/jobs/unprocessedCallSweepJob.ts` schedules a sweep. `services/unprocessedCalls/unprocessedCallStore.ts` selects pre-call evidence with no `call_logs` row; `unprocessedCallSweep.ts` reads VAPI/Twilio state; `unprocessedCallNotifier.ts` claims a notice and rechecks for a late log before sending. Any existing log, including an error outcome, excludes the call: this sweep does not detect incomplete clinical processing once a log exists, and log presence does not prove completed clinical actions. Interrupted sends have an explicit terminal disposition. `services/postcall/unfinishedVapiRecord.ts` prevents an unfinished vendor report from masquerading as a completed empty call.

Abby already has `src/voice/call-liveness-monitor.ts`, unattached-call closure, terminal reasons and operator alert ownership. Those handle known application sessions. A proposed addition is independent completeness accounting, including calls lost before application admission where authorized provider evidence permits it. Karen's sweep itself requires its pre-call log; it does not establish that broader coverage. Compare permitted own-stack carrier/admission evidence to terminal observations and surface bounded aggregate anomalies through the existing operator workflow. Missing completion is neither proof that no booking was written nor proof of which writer created a matching appointment.

This extension depends on authorized tenant-scoped provider inventory exposing sufficient operational evidence. Reuse permitted terminal observations and aggregate alerts; do not introduce a durable call-specific ledger, retained matching identifiers, patient-specific queue or caller record. If completeness cannot be proved within Abby's storage contract, report the coverage limit. Patient-specific recovery details require a permitted provider/host workflow.

**Acceptance:** with an authorized independent inventory, lose the completion event of a synthetic carrier-completed call, including a call never admitted by the app. Produce an owned anomaly without prohibited persistence. Late completion observed before notice dispatch suppresses that notice; an already accepted notice cannot be retracted. Duplicate monitors and a killed notifier do not repeat a possibly sent notice or initiate an appointment mutation. Do not copy Karen's caller/transcript logs, thresholds, notification-toggle overrides or dry-run settlement policy.

**Karen witnesses:** `server/src/__tests__/unprocessedCalls/unprocessedCallRecovery.crosslayer.test.ts` and `server/src/__tests__/unprocessedCalls/unprocessedCallStore.integration.test.ts`. [Sweep source](/home/gust/code/karen-website-dev/server/src/services/unprocessedCalls/unprocessedCallSweep.ts).

### R02 Explain alternatives while retaining the requested option

**Extend gaps 5–7.** `server/src/services/pms/formatting/alternativeContext.ts` distinguishes a missed requested date, a materially sooner alternative, a caller-requested comparison and a `requested_no_times` reason whose original availability can still be unknown. It separately carries practitioner/duration changes and known, unknown or unavailable requested-day coverage. `masterToolsController.ts` attaches the resulting context beside the availability rows. Read both the reason and original-availability state; the reason alone cannot establish a successfully empty search.

Abby already supports approved practitioner choices, destination authority, private menus and invalidated offers. Extend the presentation only where clinic policy permits comparison: for example, original practitioner tomorrow versus an approved colleague today. Keep the original option, actual duration and exact service visible. An unreadable original search must not become “fully booked.” Models receive structured public choices, not native IDs or permission to substitute a service.

**Acceptance:** after hearing the comparison, the caller asks again about the original and selects it; only that exact original writes. Repeat with unknown original availability, an alternative missing the requested day, different duration/service/practitioner, and withdrawal after hearing the substitute.

**Local R02 candidate, 27 October 2026:** The approved single-service booking
catalogue now has 20 source checks and three emitted signed SQL passes for original versus
earlier/equal/empty comparison, fresh original return and refusal boundaries.
Four existing signed search/deadline checks also pass. The original failure is
retained; only the new SQL test's exact canary registration was added. Existing
tie order, the native limit of 180 requests per minute, real deadlines and full SQL/backup privacy remain. Service
substitution retains its separate approval/selection path; no original cached
time becomes a selectable offer. Current strict types and a serving build with 745 outputs emission passes. Review,
normal delivery and real clinic/voice acceptance remain separate. See the
[qualification and retained failures](EXECUTION_PROGRESS.md#approved-practitioner-comparison-27-october-2026).

**R02 review correction, 27 October 2026:** Five actual emitted signed SQL cases
now pass, including a return to the original practitioner followed by an explicit
approved duration or service correction. Each correction cancels the old proposal,
obtains fresh private verification and confirms only the final exact type/interval.
Current whole strict types pass; 746 serving outputs retain all 745 prior bytes.
The original 20 source checks and four earlier search/deadline cases retain their original
evidence. Failed fixture/wrapper attempts remain recorded, with independent
reconciliation of successful original compiler and SQL phases. Review and normal
delivery remain separate; no clinic, acoustic or activation acceptance is claimed.
See [the correction and evidence](EXECUTION_PROGRESS.md#composed-r02-service-and-duration-correction-27-october-2026).

**Karen witnesses:** `server/src/__tests__/e2e/alternativeSuggestionsCrossLayer.test.ts`. [Alternative context source](/home/gust/code/karen-website-dev/server/src/services/pms/formatting/alternativeContext.ts).

### R03 Preserve the correction regression corpus

**Preserve gaps 5, 8 and 9.** Karen's appointment-type-change and clinic-switch flow maps show why several individually successful tool calls can still leave a rejected old selection available to later processing. Its `bookingRevisionCollapse.ts` and `multiAction/reconcilePlan.ts` reconstruct revisions after the call.

Abby's action identity, conversation generation, fresh selection and separately played affirmation are the better foundation. Add the scenarios: longer type at the same time; another clinic with the same clock time; another practitioner; final negative confirmation; and two legitimate same-day appointments that look similar. Superseded offers must not write, but separate authorized actions must remain distinct. A completed action remains a receipt when the caller requests a later change.

Do not transplant Karen's collapse key based on practitioner/type/business/day or fuzzy time/name matching. Those keys do not establish that two requests are revisions of the same action.

**Karen witnesses:** `server/src/__tests__/postcall/appointmentTypeChangeMidCall.test.ts`, `server/src/__tests__/postcall/bookingRevisionCollapse.test.ts`; maps `docs/flows/appointment-type-change-midcall.md` and `clinic-switch-midcall.md`. [Revision collapse source](/home/gust/code/karen-website-dev/server/src/services/postcall/handlers/bookingRevisionCollapse.ts).

### R04 Keep caller identity separate from every action subject

**Preserve gap 9.** Karen's `multiAction/bookPatientResolver.ts` maps each leg, but also contains unresolved-slot fallback to the phone-primary and same-first-name heuristics. The manage-target and caller-attribution maps expose mutable selected-appointment state crossing actions.

Abby's `src/standalone/cliniko-call-tasks.ts` pins the root caller, requires fresh subject proof and independent authority for its explicitly approved self/related-person task cohorts, retains settled receipts and blocks progression on uncertainty. That does not establish arbitrary representative or every operation/catalogue combination. Keep the design. Use Karen as a test inventory: shared phone, same first name, another person's appointment, subject switch with omitted target, unrelated representative, and changed notification recipient. Each write, fee/consent and message must retain the exact authorized subject. Household membership, suffix matches and phone recognition cannot grant authority.

**Acceptance:** two same-named people share a phone; the second task omits its target. Refuse ambiguity without changing the first task's receipt or using its proof for the second patient. Retain Abby's `test/cliniko/representative-task-sequence.test.ts` witnesses.

**Karen pointers:** `docs/flows/manage-target-resolution.md`, `postcall-caller-identity-attribution.md`; [patient resolver](/home/gust/code/karen-website-dev/server/src/services/postcall/multiAction/bookPatientResolver.ts).

### R05 Keep unknown reads distinct from successfully empty reads

**Preserve gaps 1, 2 and 6.** `transient/dataFetchers/patientLookupFetcher.ts` can retain an identified caller while marking appointment retrieval unavailable. `transient/shared/appointmentStateLanguage.ts` carries that distinction into speech. Abby already has typed read failures; qualify the complete serving route rather than adding another status system.

**Acceptance:** identity lookup succeeds but appointment/class retrieval fails or exceeds the shared budget. State inability to check; do not treat the failed read as evidence of no appointments, new-patient status or permission to book. An independently authorized new booking is not universally prohibited by an unrelated failed read. Contrast a genuinely complete empty read. Late callbacks after retirement cannot publish stale results. Apply the distinction to outbound consumers as well as pre-call lookup.

**Local read-failure wording, 25 October 2026:** Existing typed failed/empty states were distinct, but a disabled staff route replaced the appointment-read explanation with a no-staff-work notice. A revised standalone voice assertion reproduced that missing explanation on synthetic 503. The correction retains the public inability-to-check/verify prefix and appends the existing staff suffix; staff availability, effects, booking authority and deadlines remain unchanged. Seventeen [source controls](../test/voice/standalone-verified-appointment-read.test.ts), including [both staff modes and failed/empty evidence](../test/text/read-failure.test.ts) and [scoped appointment readers](../test/voice/appointment-read.test.ts), and seven selected SQL-ledger controls pass. Whole strict TypeScript and 744-output serving emission pass with only the transition changed from reviewed local parent `6fe1524a`; 743 outputs remain exact. Additional emitted signed/SQL individual and class cases contrast unavailable and complete empty reads; the class case then retains its original played consent and exact cancellation. Nine signed outgoing cancellation controls include native failure, complete empty and actual shared cooldown with no extra provider GET or clinical action. Two signed/SQL controls retain fresh operation verification and exact confirmation before an independent booking after a failed read, and prove a retired enquiry cannot publish a held late successful response. Whole strict and the final 744-output graph pass; only the production transition and three synthetic fixture modules differ from reviewed local `6fe1524a`, with 740 exact. The earlier graph is separately retained through explicit path mapping. See the [combined local evidence](EXECUTION_PROGRESS.md#appointment-read-explanations-when-staff-work-is-unavailable-25-october-2026). Parent integration, own CI/delivery and real-provider/carrier/clinic acceptance remain separate; no permission, booking authority or runtime default is enabled by these fixtures.

**Karen witnesses:** `server/src/__tests__/transient/unknownAppointmentsClinikoCrossLayer.test.ts`. [Lookup source](/home/gust/code/karen-website-dev/server/src/services/transient/dataFetchers/patientLookupFetcher.ts).

### R06 Keep per-action outcomes and notification results independent

**Preserve gap 9 and the booking plan.** `postcall/handlers/multiActionHandler.ts` retains each leg's result; `postcall/notifications/multiActionNotifications.ts` buckets those results for downstream messages. This supports the already planned rule that an observer cannot undo a native result.

Abby already has typed action states, deterministic outcome wording, review and notification delivery accounting. Add a cross-reader witness: cancellation succeeds, a sibling booking is rejected or unknown, then reporting/notification fails. Every caller/staff/report view retains the cancellation and accurately reports the sibling. Transport acceptance never implies a human read a message. Do not copy Karen's fixed cancel/move/book ordering or overlapping post-call planners.

**Local cross-reader evidence, 25 October 2026:** Two [notification regression cases](../test/text/notification-effects.test.ts) retain a played cancellation confirmation and immutable cancellation record while a later booking is rejected or uncertain. Notification send/observation failures and a failed report read neither undo the cancellation nor retry writes or sends; reconstructed staff/report readers retain both action statuses and accurate aggregate counts. A new-task query first reproduced an old-receipt attribution defect; ordinary and notification queries now share receipt selection and wording that exclude previous-task actions while retaining their records. All 33 notification controls pass on memory and PostgreSQL ledgers, alongside whole strict TypeScript, serving emission and two metadata contracts. Of 744 serving outputs, only the shared action-outcome module and its transition/notification consumers change; the other 741 remain exact. Review and this correction's own CI/delivery are pending. These reference-host fixtures do not establish real-provider or full-call acceptance.

**Karen witnesses:** `server/src/__tests__/postcall/multiAction/multiActionHandler.test.ts`; its inspected success-plus-failed-move fixture has two legs even where the test title mentions three. [Handler source](/home/gust/code/karen-website-dev/server/src/services/postcall/handlers/multiActionHandler.ts).

### R07 Retain correlated batch protocol lessons for a future model adapter

**Later, conditional on an actual batch interface.** Karen's `controllers/transient/toolRequest.ts` normalizes supported envelopes, correlates each result to the original invocation ID, deduplicates mirrored copies of that ID and refuses conflicting copies. Identical arguments under distinct IDs remain separate invocations. `masterToolsController.ts` executes sequentially under a whole-request deadline and retains completed siblings.

Abby does not need VAPI envelope variants. If a future adapter supports several model calls in one response, preserve one result per original ID, explicit malformed-item errors, sequential state-changing execution, a shared bounded deadline and no whole-batch replay. Batch parsing does not authorize several clinical mutations or establish durable cross-process exactly-once execution.

**Acceptance:** conflicting duplicate IDs, one malformed sibling, success followed by expiry and a late callback. Intended calls execute once and completed results survive; no guessed IDs or fallback replay.

**Karen witnesses:** `server/src/__tests__/transient/masterToolsController.batchHttp.test.ts`, `server/src/__tests__/transient/masterToolsController.batchClaims.test.ts`. [Parser source](/home/gust/code/karen-website-dev/server/src/controllers/transient/toolRequest.ts).

### R08 Generate any future prose from trusted outcomes

**Preserve current structured reports; extend gap 13 only if prose is approved.** Karen's `postcall/ai/agents/call-summary.ts`, `email-summary.ts` and `handlers/impossibleActionHandoff.ts` supply executed-outcome context separately from prompt text and apply spoken-DOB redaction.

Abby's structured review and deterministic result text avoid reconstructing execution from a transcript. Keep those as the default. Future approved summaries/writeback must take allowlisted trusted action facts, not infer success from a caller or model saying “booked.” Redaction is defense in depth, not permission to retain transcripts.

**Required Abby acceptance:** spoken success conflicts with an unknown native result; the summary cannot claim success. Two patients and a spoken DOB cannot cross-leak. A legitimate appointment date is included only when its destination and storage policy permit it. These are target requirements, not a claim that the cited Karen tests establish all multi-patient cases.

**Karen witnesses:** `server/src/__tests__/postcall/summaryAgents.test.ts`, `server/src/__tests__/utils/redactSpokenDob.test.ts`. [Summary source](/home/gust/code/karen-website-dev/server/src/services/postcall/ai/agents/call-summary.ts).

## Clinic setup and knowledge

### R09 Explain readiness using one current read model

**Extend gaps 1–5.** Karen's `services/onboarding/setupReadinessService.ts` derives setup state from catalogue selections, configuration, provisioning, call evidence and explicit checklist ticks. The dashboard and support assistant consume that same current view. The useful transfer is an explanation of what remains missing, not Karen's exact checklist.

Abby already has scoped `src/core/readiness.ts`, default-unproven admission and admin setup panels. Add reasons and next authorized actions from those existing requirements. A page visit, saved setting, self-marked test call or synthetic speech test must never grant patient admission. Do not retain caller-number history to generate an onboarding badge.

**Acceptance:** expiry, revocation and failed catalogue reads remain blocked; browser/API/compiled runner agree on tenant and current state; an unavailable read is distinct from an empty configured catalogue; visiting a page cannot enable automation.

**Scoped implementation, 25 October 2026:** both existing automation setup surfaces now share fixed labels and next authorized actions from the current server failure. The local screen's former generic-only refusal was reproduced before correction. Three source controls and both existing browser workflows pass, including the actual missing-requirement API response, supervised next step and empty audit after visiting or rejected activation. Whole strict TypeScript and fresh serving emission originally passed on qualified parent main `1582b193`. After integrating independently qualified PR605 main `1b9359f5`, both checks passed again and all 744 current serving outputs match that actual parent. The six code/test files and both tested dashboard bundles remain unchanged; the original serving graph and bundles are preserved separately. Eight selected unchanged catalogue/admission controls retain their qualified parent PostgreSQL evidence. This is local explanation and retained boundary evidence, not fresh execution of the entire matrix, readiness approval, clinical activation or complete R09 acceptance. Final review and this correction's own delivery remain pending. [Shared explanation](../src/standalone/dashboard/readiness-message.ts), [source controls](../test/text/readiness-message.test.ts), [local browser](../test/browser/local-automation.spec.ts), [ordinary browser](../test/browser/dashboard.spec.ts).

**Karen witnesses:** tests named `server/src/__tests__/setupReadinessService.test.ts`, `server/src/__tests__/setupReadinessController.test.ts`, `server/src/__tests__/setupReadinessAndStage.crosslayer.test.ts` and `server/src/__tests__/assistant/assistantSetupProgress.test.ts` under `server/src/__tests__`. [Readiness source](/home/gust/code/karen-website-dev/server/src/services/onboarding/setupReadinessService.ts).

### R10 Keep public knowledge provenance and invalidate every consumer

**Extend existing knowledge under gaps 1 and 5.** FAQ create/edit/delete/reorder and bulk writers in `services/cliniko/client/clinikoFaqService.ts` and its controller clear process-local answering caches. `services/faq/faqAnswerService.ts` builds bounded general-information answers; `controllers/transient/faqSearchController.ts` distinguishes usable evidence, a miss and a retrieval error. The cache has a 300-second TTL; clearing one process does not establish fleet-wide invalidation. The flow map `docs/flows/faq-kb-pipeline.md` identifies otherwise easy-to-miss profile and bulk writers.

Abby already has content fingerprints, approved public FAQ provisioning, source/version validation and revocation. Extend that system rather than enabling its reference free-text database catalogue. A later safe editor must update all actual voice/admin consumers. Public facts do not authorize diagnosis, private appointment disclosure or a different booking procedure.

**Acceptance:** CRUD and bulk edits invalidate each consumer across serving processes, or satisfy an explicitly approved bounded freshness contract. Revoked facts stop being usable under Abby's snapshot contract; partial answers acknowledge their limits; numbers and prices are exact; retrieval errors cannot become “not offered”; no patient content enters public facts or logs.

**Karen witnesses:** `server/src/__tests__/services/faq/faqAnswerService.test.ts`, `server/src/__tests__/transient/faqSearchController.test.ts` and `server/src/__tests__/knowledge.crosslayer.test.ts` under `server/src/__tests__`. [Answer source](/home/gust/code/karen-website-dev/server/src/services/faq/faqAnswerService.ts).

### R11 Maintain code backed product facts separately from support advice

**New operator-maintenance capability; start small after the booking contract.** Karen's `assistant/knowledge/productReference.ts` associates facts with IDs, code paths, verified dates and setting IDs. Fingerprint tests detect changed wording; dependent playbook advice must be rechecked. `playbook.ts` keeps a working set separate from published snapshots; `assistantKnowledge.ts` combines reference hash and published version for the consumer.

Abby's clinic FAQ catalogue describes a clinic, not how Abby's product works. Add a small repository-owned operator reference and freshness checks first. An AI support chat, publication UI or support database is optional. Read current settings through Abby's existing server-derived actor/gateway; model arguments cannot choose authority. Preserve deployment, advice publication and clinic acceptance as separate events. If publication is later added, use version fencing rather than copying Karen's `MAX(version)+1` approach.

The source fingerprint guards hash declared fact content, not product behaviour. They catch changed wording, missing references and stale declared dependencies; reviewers must still compare unchanged prose with changed code. A green fingerprint test does not establish that a factual claim is correct.

**Acceptance:** removed source/settings references and changed facts without reverification fail; stale dependent advice fails; drafts never alter published answers; publication/readback identify one version across processes; unavailable settings stay unknown; help cannot change settings or certify readiness.

**Karen witnesses:** `server/src/__tests__/assistant/productReferenceContent.test.ts`, `server/src/__tests__/assistant/referenceFingerprints.test.ts`, `server/src/__tests__/assistant/playbookSeed.test.ts`, `server/src/__tests__/assistant/playbook.test.ts`, `server/src/__tests__/assistant/playbook.integration.test.ts`, `server/src/__tests__/assistant/assistantKnowledgeFlow.integration.test.ts`. [Reference source](/home/gust/code/karen-website-dev/server/src/services/assistant/knowledge/productReference.ts).

### R12 Evaluate every visible support response fragment

**Companion to R11.** Karen's `server/src/testing/askAi/` and `server/src/__tests__/askAiEval/harness.test.ts` capture the actual response stream, distinguish last-answer text from all displayed intermediate fragments, and apply deterministic prohibitions before an optional model judge. Failed turns, unavailable costs and targeted subsets retain their own evidence limits.

Abby already has scenario manifests and repeated speech/intent evaluation. Add this method only for a future operator/support answering surface; it does not replace acoustic qualification or clinical call tests.

**Acceptance:** a forbidden/private claim in an early fragment fails even when the final answer is good. A stream/usage failure cannot pass as a successful answer. Tool failures remain explicit inputs rather than factual absence. Preserve every failed repeat and record source/model/knowledge/fixture identities. A targeted pass is not a full-catalog or published-answer pass.

**Karen witnesses:** `server/src/__tests__/askAiEval/catalogAndJudge.test.ts`, `server/src/__tests__/askAiEval/inProcessDriver.integration.test.ts`. [Harness witnesses](/home/gust/code/karen-website-dev/server/src/__tests__/askAiEval/harness.test.ts).

### R13 Suggest public clinic vocabulary without bypassing speech gates

**Extend gap 4.** Karen's `transcriber/profile/profileInputs.ts` canonicalizes selected services, practitioners, locations, specialties/categories and free-text company information. Those inputs are not intrinsically public or patient-free. `profileBuildService.ts` computes hashes/diffs, respects removed terms and caps suggestions; save hooks plus a reconciliation sweep cover missed writers. The existing flow map also records a stale-editor overwrite/suppression race worth testing rather than inheriting.

Abby already bounds transcription context, verifies actual realtime session configuration and versions voice settings. Whitelist approved public clinic terminology before extraction; do not treat unreviewed free text as public by default. An authorized clinic owner reviews suggestions before they reach transcription. Suggestions preserve manual edits/removals and conflict on stale versions. No per-call patient-name vocabulary, discipline-derived clinical authority, automatic speech-provider fallback or VAPI-specific settings are transferred.

**Acceptance:** deterministic extraction/caps, current complete catalogue, manual deletion persistence, stale-save refusal, and actual session consumption. Run the unchanged repeated quiet/noisy/date/correction/accent gates and retain every critical miss; a vocabulary unit test cannot promote speech readiness.

**Karen witnesses:** tests in `server/src/__tests__/transcriber/profile/`, plus `server/src/services/transient/variables/transcriberConfig.test.ts`; `docs/flows/transcriber-auto-vocab-profile.md`. [Build source](/home/gust/code/karen-website-dev/server/src/services/transcriber/profile/profileBuildService.ts).

### R14 Import authentication threat scenarios without another login stack

**Preserve gaps 2 and 3.** Karen's MFA and assistant-access paths supply useful destination, authenticated-actor and tenant-scope tests. Its auth flow map also records overlapping login/MFA routes and inconsistent trust lifetimes.

Abby already has membership-bound magic links, origin/CSRF controls, secure cookies, atomic redemption, shared rate limits and current-role checks in `src/standalone/identity/` and `src/storage/postgres-magic-link-store.ts`. No second authentication system is justified. Preserve those controls and qualify the actual proxy/cookie deployment separately. Do not copy localStorage JWTs, device-fingerprint trust scoring or SMS overrides.

**Acceptance:** membership revocation invalidates challenge/session; another tenant cannot be selected via payload/header; concurrent redemption creates one session; processes share budgets; failed/lost email delivery cannot mint identity; email possession does not grant clinical permission.

**Karen witnesses:** tests named `server/src/__tests__/mfaService.test.ts`, `server/src/__tests__/mfaCodeDestination.test.ts`, `server/src/__tests__/assistant/assistantAccessAndHistory.test.ts`; `docs/flows/webapp-auth-login-mfa.md`. [Server actor source](/home/gust/code/karen-website-dev/server/src/services/assistant/assistantAccess.ts).

## Provider setup and catalogue maintenance

### R15 Preserve approval through incomplete catalogue refreshes

**Local R15/R16 evidence, 27 October 2026:** Four additional witnesses, within
26 passing catalogue/setup/gateway controls, exercise exact saved-approval
preservation, discovery without automatic approval and revocation/rotation while an
actual native relationship page is held. Current strict types and the reused
746-output serving graph pass with no production change. Independent custom
service metadata and authenticated clinic acceptance remain separate; this does
not close every R15/R16 acceptance item. See [qualification and limits](EXECUTION_PROGRESS.md#catalogue-refresh-and-stale-setup-qualification-27-october-2026).

**Extend upkeep under gaps 5 and 6.** Karen's `nookalCatalogSyncGuard.ts` captures credential/selection versions before native fetching and rechecks them at commit. `pms/data/pmsIngestionService.ts` performs update-only ingestion that keeps unseen entities out of approved mappings. Provider sync readers distinguish unknown relationships/prices from complete absence. Formatting rebuilds and cache invalidation are separate downstream steps whose actual consumers need qualification; the source does not establish uniformly consistent invalidation.

Abby already has complete bounded reads, explicit catalogue approval, credential binding and compare-and-swap. Add only missing refresh witnesses: partial native reads cannot erase approved choices; new members cannot auto-enable themselves; existing custom names, prices and operator exclusions survive. Keep the fresh serving version aligned with the approved catalogue. Do not inherit Karen's parallel legacy/standardized table models or a helper that stops at a page cap and reports success.

**Acceptance:** short/duplicate/inconsistent/partial pages preserve prior approved metadata and deny uncertain offers. Prove true removal separately. Rotation/disable while a page is held invalidates the commit; newly discovered entities need approval; all call readers consume the same committed approved version.

**Karen witnesses:** `server/src/__tests__/pms/data/pmsIngestionService.updateOnly.test.ts`, `server/src/__tests__/pms/clinikoSyncFailureCrossLayer.test.ts`, `server/src/__tests__/migrations/nookalOnboarding.integration.test.ts`. [Version guard](/home/gust/code/karen-website-dev/server/src/services/nookal/nookalCatalogSyncGuard.ts).

### R16 Make partial setup and reconnect recoverable without stale activation

**Extend earlier activation work; reference for future providers.** Karen's `nookalOnboardingConnection.ts` stages setup, reuses failed attempts, changes credential revision when needed and finalizes only the exact verified attempt. `nookalConnectionAdmin.ts` clears verification/readiness/capabilities on rotation. Catalogue/readiness completion compares captured revisions; operator disable must defeat stale completion.

Abby already revokes stale catalogue approval after credential rotation, including signed serving-path tests. Supplement it with failed/partial reconnect and stale-worker cases. Connection, selected catalogue, read readiness, write readiness and optional capability remain separate. Future OAuth/token support is new scope; it does not justify inventing that machinery for the current API-key adapter.

**Acceptance:** rotate during held native work, retry partial failure, disable during setup, finish an abandoned old attempt, and reapprove through authenticated admin. No stale completion reactivates a connection or grants clinical authority.

**Karen witnesses:** `server/src/__tests__/migrations/nookalOnboarding.integration.test.ts`, `server/src/__tests__/admin/pmsConfigAdminController.test.ts`. [Setup source](/home/gust/code/karen-website-dev/server/src/services/nookal/nookalOnboardingConnection.ts).

### R17 Keep provider support explicit at each operation

**Preserve the current Cliniko seam; later for additional providers.** Karen's `pmsProviderCapabilities.ts`, `outboundPmsAdapter.ts`, `outboundPmsRegistry.ts` and deposit adapter distinguish operation support and keep native translation behind adapters. The useful lesson is the operation matrix and refusal scenarios, not the number of registered providers.

Abby already has host capability modes and independent permission. Keep unknown providers unsupported. Karen's first-registered/default-provider fallback, unknown-capability fallback to Cliniko and registered stub providers must not become Abby defaults. Adding Splose, PracSuite or Nookal is separate scope requiring identity, time, quota, pagination, response and recovery proof for each operation.

**Acceptance:** unsupported campaign/deposit/write fails before fetching patients, saving work or claiming capacity. An unknown or changed provider cannot inherit Cliniko permission. An existing connection with one optional capability missing remains usable only for its proven operations.

**Karen witnesses:** `server/src/__tests__/pms/pmsProviderCapabilities.test.ts`, `server/src/__tests__/pms/outboundPmsRegistry.test.ts`, `server/src/__tests__/ob/nookalOutboundCapabilityGate.test.ts`. [Capability source](/home/gust/code/karen-website-dev/server/src/services/pms/pmsProviderCapabilities.ts).

## Concrete supplements for gaps eleven to thirteen

### R18 Separate payment truth from appointment and delivery truth

**Extend gap 11; preserve this reference before its implementation starts.** Karen's `deposits/paymentLinkService.ts` reads clinic settings/connected-account readiness, creates a deposit record and Stripe Checkout Session, then returns a link to notification consumers. Deposit webhook handlers verify the Stripe signature, then update Karen's local deposit status before optional notes, receipts and notifications. `expiryService.ts` rechecks expiry/status; `depositsActionsService.ts` dispatches any separately authorized appointment cancellation and sends cancellation SMS only on actual cancellation success. Staff mark-paid also attempts to expire a still-payable link.

Model link creation, delivery acceptance, payment, appointment change, expiry and receipt attachment separately. Bind exact trusted clinic/account, patient/action, amount/currency and approved recipient. Abby's existing `src/core/financial-evidence.ts` is a refusal contract, not an implementation of payments. Class pass counters also do not prove payment. Preserve acknowledged booking success through optional payment/attachment/notification failure.

Patient-specific financial state must have an approved provider/clinic owner. Do not copy `appointment_deposits`, patient-bearing jobs or Stripe metadata/logging into Abby's standalone database.

**Acceptance:** response loss creating a payable session; foreign account/amount/currency; duplicate and out-of-order payment events; payment versus expiry/manual-mark-paid/cancellation races; process loss at each acknowledgement. Late payment does not restore a cancelled appointment. Failed upload does not undo paid status. Mail/SMS transport acceptance does not prove receipt.

**Karen witnesses:** `server/src/__tests__/deposits/depositsActionsService.test.ts`, `server/src/__tests__/deposits/markDepositAsPaid.test.ts`, `server/src/__tests__/deposits/paymentLinkTransaction.test.ts`, `server/src/__tests__/deposits/webhookTransactionRelease.test.ts`, `server/src/__tests__/deposits/clinikoDepositAdapter.test.ts`. [Payment link source](/home/gust/code/karen-website-dev/server/src/services/deposits/paymentLinkService.ts).

### R19 Use Karen payment races as adversarial requirements

**Extend gap 11.** The pinned Karen source has separate requirement decisions in pre-call wording, in-call confirmation, post-call dispatch and link creation. It re-derives patient status at different stages; an internal requirement cache prefix is not covered by the same clearing prefix. Deposit paid handlers select without `FOR UPDATE` and can fall back to the latest pending row for company plus phone. They do not establish exact connected-account, amount/currency or checkout payment-status matching; those remain required Abby acceptance checks. Expiry commits a status before native cancellation. These are source-visible risks, not a claim about current live incidents.

Use one approved requirement result for spoken terms and dispatch, bound to patient/selection/policy; invalidate it when those change. Unknown requirement is not “not required.” Match payment evidence by exact provider/account/event/action identities, never phone/amount recency. Prove payment/expiry mutual handling and record real appointment outcomes separately from timer status.

An expired payment row is not evidence that native cancellation succeeded. A later payment cannot silently restore an appointment; cancellation uncertainty and late payment require separately owned outcomes.

Karen's separate subscription `stripeWebhookEventStore.ts` supplies atomic event-claim and stale-worker tests, but its controller explicitly processes on ledger outage. Do not assume that ledger protects deposits or copy the fail-open choice. A reclaimed event cannot grant a second clinical send.

**Karen witnesses:** `server/src/__tests__/controllers/stripe/webhookEventIdempotency.test.ts`, `server/src/__tests__/controllers/stripe/stripeWebhookEventStore.integration.test.ts`, plus R18. Preserve `docs/flows/deposits-flow.md` as historical navigation only; current expiry policy differs from older map details. [Deposit webhook source](/home/gust/code/karen-website-dev/server/src/services/deposits/webhookService.ts).

### R20 Build outbound campaigns separately from recall requests

**Extend gap 12.** Karen's `obPatientLoadingService.ts` validates provider/capability, loads candidates and checks DNC/cancellation around waits. `obSchedulerService.ts` handles due work/restarts; `obQueueService.ts` claims one recipient and dispatches; `obConcurrencyService.ts` controls capacity. Launch reloads current native context. Result ingestion records each outcome, opt-out and slot release.

Abby already has provider-owned recalls, aggregate queue monitoring and review recovery. None supplies an approved audience, outbound dial scheduling, DNC, quiet hours or campaign cancellation. Retain the orchestration sequence and tests, using Abby's own voice runtime and permitted provider/clinic storage. Karen's patient campaign tables and singleton/VAPI/legacy outbound stacks are unsuitable infrastructure.

**Acceptance:** explicit purpose/audience/timezone/location/service scope; opt-out during loading, scheduling, just before dial and in a callback; unavailable DNC denies dialing; duplicate schedulers/callbacks and process death neither double-dial nor strand capacity. Distinguish no-answer, voicemail, failed launch, opt-out, successful clinical action and unknown action. Enforce quiet hours/DST and refreshed policy/quota through the real dispatch seam.

**Karen witnesses:** `server/src/__tests__/ob/nookalOutboundCandidateSelection.test.ts`, `server/src/__tests__/ob/nookalOutboundCapabilityGate.test.ts`, `server/src/__tests__/ob/obOutboundLaunchService.test.ts`. [Outbound adapter](/home/gust/code/karen-website-dev/server/src/services/pms/outboundPmsAdapter.ts).

### R21 Pin the exact sick day or callback appointment end to end

**Extend gap 12.** Karen's `langgraph/state/initialContextBuilder.ts` separately carries an exact campaign appointment into later management resolution when phone-derived context is empty. It refuses a pin contradicted by a populated snapshot. The callback controller produces the target and `rescheduleHandler.ts` consumes it. This matters when one household number or patient has several appointments: the soonest appointment is not necessarily the campaign's appointment.

Abby's verified subjects and exact action targets should carry an independently authorized outbound target through admission, callback and any resulting move. Campaign identity is context, not patient authority. A target changed, cancelled or contradicted at dispatch must refuse/escalate, not silently switch appointments. An inbound caller asking about a missed call needs verified campaign context before Abby can explain its purpose; its current generic missed-call response is deliberately limited.

**Acceptance:** two appointments, shared household phone, empty lookup, conflicting snapshot, wrong patient, stale callback and cancelled target. Only the exact currently authorized campaign appointment can change; absent/ambiguous context never chooses the soonest.

**Karen witnesses:** `server/src/__tests__/postcall/obRescheduleSickTargetChain.test.ts`, `server/src/__tests__/langgraph/obCampaignTargetScoping.test.ts`. [Context source](/home/gust/code/karen-website-dev/server/src/services/langgraph/state/initialContextBuilder.ts).

### R22 Give notes and attachments distinct permissions and receipts

**Extend gap 13.** Karen's `postcall/notes/patientCallNoteWriter.ts` gates capability, resolves a target, composes transiently, acquires a per-call/per-target claim and retains known native success through bookkeeping failure. It releases claims on some failed-write paths; that does not prove safe replay after response loss. Abby must preserve uncertainty and provider-owned recovery. `appointmentNoteCandidates.ts` and `appointmentNoteWriter.ts` derive per-target work from actual action outcomes. The Cliniko adapter reads exact individual notes before merged PATCH and refuses shared class notes. Patient memo, appointment admin note, shared class note and patient attachment are different operations. Vendor endpoint names are not interchangeable; PracSuite `/note` is a calendar block, while patient memos use a different resource.

Abby's correlation notes and provider-owned review envelopes do not implement general chart/document writeback. Require separate clinic-approved content/category/author/target/retention authority. Reuse exact verified subjects and action results. Do not copy phone-unique attribution, transcript tail hooks, local patient idempotency tables or retry-on-any-error.

**Acceptance:** two subjects, ambiguous target, attendee/appointment IDs that resemble each other, failed read, concurrent staff edit, native response loss and bookkeeping failure after acknowledgement. Preserve prior staff text and report read-modify-write races honestly; Karen does not supply atomic append. No individual text may land on a shared class record.

`services/cliniko/patientAttachmentService.ts` separately obtains presigned upload fields, uploads bytes and creates the native attachment. Test trusted upload destinations, size/expiry bounds, each response-loss point, upload-success/native-create-failure and orphan ownership; upload alone is not completed attachment. The inspected receipt-delegation test does not establish full attachment qualification.

**Karen witnesses:** `server/src/__tests__/postcall/patientCallNoteWriter.test.ts`, `server/src/__tests__/postcall/patientCallNoteOrchestratorExits.test.ts`, `server/src/__tests__/postcall/appointmentNoteCandidates.test.ts`, `server/src/__tests__/postcall/appointmentNoteWriter.test.ts`, `server/src/__tests__/pms/clinikoAdapterAppendAppointmentNote.test.ts`. [Note writer](/home/gust/code/karen-website-dev/server/src/services/postcall/notes/patientCallNoteWriter.ts), [attachment stages](/home/gust/code/karen-website-dev/server/src/services/cliniko/patientAttachmentService.ts).

## Operations and optional product breadth

### R23 Make startup and monitoring prove fresh work

**Extend gap 3.** Karen's `webStartup.ts` orders required gates before services/listening. `scheduledJobHeartbeat.ts` stamps task invocation through isolated bounded monitoring writes; readers distinguish missing/stale/unavailable from healthy zero. An invocation heartbeat does not prove that the task progressed or finished. It provides concrete startup, stopped-worker and monitor-failure cases, not a full successful-work monitor.

Abby already performs privacy preflight, bounded health probes, separate health/readiness responses, queue monitoring, durable aggregate alerts and operator/backup acknowledgement. Preserve those systems. Add only missing schema compatibility and freshness witnesses; process UP, a boot-seeded timestamp or a DB ping cannot establish current clinic readiness. Monitoring failures must not indefinitely block work or change a known booking result.

**Acceptance:** missing/incompatible required schema denies admission; stalled probes settle boundedly; boot timestamps cannot satisfy invocation freshness, and a started-but-stalled task cannot be called completed or healthy. Track invocation, progress/completion and failure distinctly where the job contract needs them. Restart preserves deduplication; unavailable monitoring is not zero backlog; independent stopped-runner schedules and ownership expiry/backup are exercised.

**Karen witnesses:** `server/src/__tests__/webStartup.test.ts`, `server/src/__tests__/scheduledJobHeartbeatFlow.test.ts`, `server/src/__tests__/scheduledJobHeartbeatPool.test.ts`, `server/src/__tests__/scheduledJobsStartupHeartbeatFlow.test.ts`, `server/src/__tests__/queueHealth.test.ts`. [Startup source](/home/gust/code/karen-website-dev/server/src/webStartup.ts).

### R24 Protect database transaction ownership

**Cross-cutting regression lesson.** `server/src/dbConfig.ts` tracks dirty releases to stop an early-returning raw-pg transaction from contaminating a later borrower's writes. The source flow describes how another caller's rollback or idle closure could then discard apparently successful work.

Abby uses Kysely transaction ownership; preserve it. Borrow the failure tests, not Karen's private pg-event monkeypatch. Every transactional operation must commit/rollback through its owner; unrelated work cannot join an abandoned transaction. Error telemetry records fixed classifications rather than SQL values or patient data.

**Acceptance:** early return, throw, failed statement, failed commit and nested caller-owned transaction. Borrow a connection afterward and prove that another operation's acknowledged write cannot be rolled back by the first operation's leaked state. Use real disposable PostgreSQL, not only mocked query calls.

**Karen witnesses:** `server/src/__tests__/pgTransactionLeak.crosslayer.integration.test.ts`; `docs/flows/pg-transaction-lifecycle.md`. [Pool source](/home/gust/code/karen-website-dev/server/src/dbConfig.ts).

### R25 Preserve exact release and migration evidence

**Cross-cutting before activation.** Karen's migration preflight freezes the database target/environment, checks migration state and retains recovery context; it does not itself freeze or attest the candidate source SHA. Its compatibility classifier is lexical guidance, not proof. Deployment probes, consumer/queue/readiness reads and source identity are separate evidence. The observed-tier classifier detects understated test dependencies; the strict integration runner rejects a wholly unexecuted integration tier.

Abby already has Kysely migrations, upgrade fixtures, privacy preflight, compiled runner tests and honest local/cloud/live distinctions. Strengthen missing release-target, old/new-reader and exact-artifact checks there. Do not import Karen's raw-pg migration engine, Heroku controls or one-off signed operational authorizations. A public short SHA alone is not fleet identity.

**Acceptance:** explicit unambiguous target; real old-schema upgrade with persisted fixtures; unknown writes/recovery references survive without replay; retired consumers are proved absent before destructive changes; source-matched compiled artifacts; no default tests needing live hosts/secrets. A skipped, killed or zero-executed suite is not a pass. No automatic downgrade, job purge or incompatible-reader restore to force green.

**Karen witnesses:** migration runner `server/src/__tests__/migrations/runnerTargetAuthority.test.ts`, `server/src/__tests__/migrations/compatibility.test.ts`, `server/src/__tests__/migrations/releaseScripts.test.ts`, `server/src/__tests__/migrations/realPostgres.integration.test.ts`; `scripts/test-tiers/integration-tier.test.mjs`. [Preflight source](/home/gust/code/karen-website-dev/scripts/release/migration-preflight.sh).

### R26 Consider public website import only as reviewed draft content

**Later onboarding convenience.** Karen's `demoSiteBrief/siteCrawlService.ts` applies URL checks and fetch/redirect/body budgets. Tests reject redirects to internal addresses and distinguish unavailable/blocked/script-shell pages. The URL guard resolves before fetching and is injectable; this does not prove socket-level DNS pinning. Its guard lookup precedes the fetch timer, so the fetch budget alone is not an end-to-end DNS/crawl bound. The larger website-crawling path prioritizes useful public pages and has claim/fencing machinery for asynchronous work.

Abby has explicitly approved owner-provisioned public clinic facts; it has no need for a web crawler to complete the core booking contract. If approved later, import only public clinic facts into a reviewable draft with source URLs/time and field-level provenance. Publicly visible patient stories/testimonials remain unsuitable FAQ material. Website/model output is untrusted; it cannot authorize services, clinical advice, pricing promises or automation. Do not copy Chromium/LLM infrastructure wholesale or assume every crawler path has the demo fetcher's protections.

**Acceptance:** private/reserved IPs, actual connection destinations under controlled DNS/redirect changes, stalled DNS/guard calls, non-HTML, hostile text, enormous pages, duplicate URLs, partial crawl and global-budget exhaustion. Assert the whole dependency chain is bounded, not only fetch. No internal fetch, no patient content retained, no automatic publication, no replacement of manual clinic edits and no late stale job overwrite.

**Karen witnesses:** `server/src/__tests__/demoSiteBrief/siteCrawlService.test.ts`, `server/src/__tests__/demoSiteBrief/briefExtractionRetries.test.ts`, `server/src/__tests__/demoSiteBrief/urlPriority.test.ts`. [Bounded crawl source](/home/gust/code/karen-website-dev/server/src/services/demoSiteBrief/siteCrawlService.ts).

### R27 Retain commercial lifecycle principles only if Abby owns that product

**Later; separate from patient deposits in gap 11.** Karen's `lifecycle/companyLifecycleService.ts` distinguishes voluntary pause, scheduled cancellation, non-payment suspension, reactivation and irreversible cleanup. `statusFanoutService.ts` runs optional CRM/mail notifications after the lifecycle commit and isolates sibling failures.

Abby already has automation disable/write-stop, not a commercial subscription service. If it later sells/operates subscriptions itself, keep distinct reasons and explicit transition authority; an embedded buyer can remain the owner. Commit authoritative state before observers. Do not copy Stripe plan pricing, grace periods, churn rules, discounts, CRM dependencies or fire-and-forget delivery as guaranteed notification.

**Acceptance:** stale scheduled action after reactivation, duplicate requests, failed billing acknowledgement and one failed observer. No double subscription, unintended reactivation or rollback of a committed state due to CRM/mail failure. Cleanup requires a current inventory: delete external artifacts before their only pointers, verify stages separately and do not treat a legacy status flag as evidence cleanup ran. Karen explicitly orders recording deletion before pointer loss, but other external cleanup loops can continue after failures and later delete resource pointers; do not generalize its recording invariant to all resources. Inject those failures in any Abby cleanup design.

**Karen witnesses:** `server/src/__tests__/services/lifecycle/statusFanoutService.test.ts`, `server/src/__tests__/services/lifecycle/graceReactivationCrossLayer.test.ts`, `server/src/__tests__/services/cleanup/callPathLogsPurge.integration.test.ts`, `server/src/__tests__/services/cleanup/companyCleanupService.v2.test.ts`. [Lifecycle source](/home/gust/code/karen-website-dev/server/src/services/lifecycle/companyLifecycleService.ts).

### R28 Isolate marketing and any additional channel from patient operations

**Later and conditional.** Karen's `karen-website/src/utils/appTrackingBoundary.ts` stops trackers before protected app navigation, including initial app load, back/forward and subsequent history wrapping. Preserve that privacy property if Abby ever combines marketing and operational surfaces; a separate marketing origin/document is simpler than importing history interception, GTM or consent defaults.

The widget, CMS, analytics dashboards, lead intake and CRM integrations are optional product breadth, not missing Cliniko capabilities. If a browser receptionist is later chosen, it must use Abby's same typed commands, authority, confirmation, outcome and allowed-data rules, with channel-specific delivery evidence. Karen's patient-bearing chat/session/log storage and text confirmation do not establish voice playback or new storage authority.

**Acceptance:** no tracking requests on sign-in/admin/operator/patient routes, including arrival from marketing; no operational query strings in analytics. A second channel cannot bypass verification or count a streamed message as a completed clinical action. Cross-channel duplicate work remains one authorized action under the actual owner contract. Use permitted owner/provider state; if ownership cannot be proved, refuse or require explicit resolution rather than retaining new patient-specific local correlation data.

**Karen witnesses:** `karen-website/src/__tests__/appTrackingBoundary.test.ts`, `server/src/__tests__/widget/widgetChatStreamLifecycle.test.ts`, `server/src/__tests__/widget/widgetTurnSideEffects.test.ts`. [Tracking isolation source](/home/gust/code/karen-client/src/utils/appTrackingBoundary.ts).

## What to keep out of Abby

- VAPI squads, frozen tool IDs, Make.com fallbacks and transcript-reconstructed post-call mutation. Abby owns its live voice/action protocol.
- Retired Nookal guarded booking, slot tokens, origin echoes, post-write conflict vetoes, automatic cancellation/restoration and separate verification vocabulary. The booking proposal owns the intended replacement success policy.
- Phone-primary/name/suffix guessing as patient or appointment authority, fuzzy action reconciliation, provider default fallback and registration mistaken for capability support.
- Karen patient/appointment mirrors, validation/call/support logs, transcripts, recordings, patient-bearing retry jobs, campaign/payment tables or unreviewed clinical summaries. Abby's phone-to-ID-only standalone rule remains in force; an embedded host's own authorized storage is a different contract.
- A second auth stack, arbitrary raw SQL tools, call-search/transcript support tools, wholesale CRM/CMS/widget/frontend or migration infrastructure.
- Blanket continuation after unexpected unhandled promise rejection. Karen's `processGuards.ts` deliberately does this; preserve explicit operation containment, safe fatal shutdown and known-result handling instead of importing that policy.
- Claims that a signature, a saved setting, native link creation, transport acceptance, an empty queue, a finite test or a deployed build proves the next stage's authority or acceptance.

## Coverage and execution priority

| Surveyed Karen domains | Disposition |
| --- | --- |
| Pre-call, tools, booking/manage, multi-action, notifications, summaries and unprocessed calls | R01–R08; preserve test corpus and extend narrowly. The booking proposal owns its success-policy change. |
| Setup/onboarding, catalogue, sync, cached configuration, credentials and provider registries | R09 and R15–R17; preserve Abby approvals and add missing recovery/invalidation evidence. |
| FAQ, assistant knowledge, admin settings, transcriber inputs and auth | R10–R14; current Abby foundations first; product-support reference is a small new capability. |
| Deposits, payment webhooks, receipts, outbound/callbacks, notes and attachments | R18–R22; concrete specifications for unfinished gaps 11–13, including unsafe patterns to avoid. |
| Startup, workers, database, schema/queue compatibility, monitoring and test/release guards | R23–R25; adapt invariants and real failure tests to Abby's runtime/Kysely/host. |
| Website drafting, commercial lifecycle, offboarding, marketing tracking, widget, CMS and CRM | R26–R28; optional product decisions, with narrow portable principles. No parity objective added. |

Preserve this inventory and source access now. After separate approval of the booking proposal, implement its individual/class changes and requalify affected gaps. Apply relevant safety/quality witnesses as their modules change rather than stopping the roadmap for a new platform rewrite; this is not an instruction to implement every R14–R25 extension before gap 10. Finish the existing gap 10 work, then use R18–R22 to refine gaps 11–13. R11's small operator reference can grow with those changes. Optional product expansions wait for a separate decision.

## Preserve before removing the local source

This audit preserves design knowledge, not a complete source backup. At inspection, the Karen root had 16 unmerged paths and additional staged/unstaged work; many other worktrees and local branches exist. An immutable dev tree does not contain all of that work.

Before the operator removes Karen locally:

1. Verify the exact audited Git objects and required tests can be retrieved through an independently accessible authorized repository or approved source archive. A cached remote-tracking ref or a link in this document is insufficient; remote access was not verified here.
2. Inventory every surviving worktree, local-only branch/commit, staged diff, unstaged diff and untracked source/design note. Preserve only the material its owner wants retained, in an approved destination. Review any archive for credentials, live prompts, patient data and unrelated company material; do not put a wholesale checkout, history bundle or production dump in Abby.
3. Confirm that Abby's two existing plans and this third document are committed in the repository and independently recoverable. Do not claim the local-only commit was published remotely.
4. Keep the source revision, exact paths, design summaries, scenario requirements and existing evidence limits together. Historical flow maps can describe retired behaviour; implementation at the pinned tree wins.
5. Treat service shutdown, source deletion, credentials, data retention and fixture cleanup as separate actions for their actual owners. This audit performs none of them and is not a deletion-readiness sign-off.

The durable source identity is the Karen reference repository at `34a642be8da7884b924eb02e7ccae731bd428276`. For an authorized future checkout, read a listed file from that exact commit rather than the then-current branch head. All recommended transfers still need Abby-specific tests and clinic policy where applicable.

## Refinement record

| Pass | Review and resulting correction |
| --- | --- |
| 1 Breadth and existing coverage | Surveyed major service/frontend/operations domains and compared current Abby modules with both existing plans. Classified extensions, already implemented invariants and optional products separately. |
| 2 Writer and reader traces | Followed call, provider, payment, campaign, knowledge and operational producers to consumers and test witnesses. Replaced feature-name parity with concrete adaptation requirements and preserved unknown/empty, patient/subject and action/observer distinctions. |
| 3 Adversarial draft review | Separate runtime, integrations and product/operations reviewers challenged the scratch draft. Corrected payment trust, claim scope, invocation heartbeat, local cache freshness, unchanged-fact fingerprint limits, public vocabulary input assumptions, crawler DNS/timing limits and partial cleanup claims. |
| 4 Recheck and preservation | Rechecked the revised domain sections; narrowed the lost-call sweep to its actual no-log query and failed-note claim handling to the relevant paths. Verified every explicit source/test path against the pinned tree and the local plan/Abby links. Retained unverified remote recovery and dirty-worktree limitations. |

These were source/document review passes, not signed implementation reviews, executed tests, live qualification or human acceptance. No Karen or Abby implementation is changed by this inventory.


## Historical source navigation inventory

Client application paths use the `/home/gust/code/karen-client` alias; other paths use `/home/gust/code/karen-website-dev`. Paths describe the inspected source layout, while presence refers only to the current upload.

| Historical commit | Source path | Current snapshot |
| --- | --- | --- |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/unprocessedCalls/unprocessedCallSweep.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/pms/formatting/alternativeContext.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/postcall/handlers/bookingRevisionCollapse.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/postcall/multiAction/bookPatientResolver.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/transient/dataFetchers/patientLookupFetcher.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/postcall/handlers/multiActionHandler.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/controllers/transient/toolRequest.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/postcall/ai/agents/call-summary.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/onboarding/setupReadinessService.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/faq/faqAnswerService.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/assistant/knowledge/productReference.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/__tests__/askAiEval/harness.test.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/transcriber/profile/profileBuildService.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/assistant/assistantAccess.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/nookal/nookalCatalogSyncGuard.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/nookal/nookalOnboardingConnection.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/pms/pmsProviderCapabilities.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/deposits/paymentLinkService.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/deposits/webhookService.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/pms/outboundPmsAdapter.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/langgraph/state/initialContextBuilder.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/postcall/notes/patientCallNoteWriter.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/cliniko/patientAttachmentService.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/webStartup.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/dbConfig.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `scripts/release/migration-preflight.sh` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/demoSiteBrief/siteCrawlService.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `server/src/services/lifecycle/companyLifecycleService.ts` | Present |
| `34a642be8da7884b924eb02e7ccae731bd428276` | `src/utils/appTrackingBoundary.ts` | Present |
