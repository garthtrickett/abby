# Execution progress and evidence

**Updated:** 16 October 2026. **Objective:** Work through [EXECUTION_ORDER.md](EXECUTION_ORDER.md), preserving its full thirteen-gap scope. This ledger records partial delivery; the integration is not complete or activated.

## Current position

| Execution stage | Current evidence and next action |
| --- | --- |
| 1 Aeva preservation | Independently retrieved and hash-checked 113 explicit source/test/map references at the audited revision through GitHub. All four original planning documents were published and independently retrieved at Abby `229a3596696d8ebb9bf263e58457f412898c1327`. Local-only material still requires owner selection and preservation before deletion. |
| 2 Delivery baseline | Remote main verified at `9a29e51e7f7e0a765db7674c6c75ff2087260473`; integrated draft [PR #457](https://github.com/garthtrickett/abby/pull/457) remains at `4e19e1783e2324480c9e0d0923eeaf825e04692e`. Its GitHub jobs never started because of account billing/spending limits. Focused local qualification of the receipt candidate is recorded below; whole-candidate CI remains outstanding. |
| 3 Exact receipt foundation | Implemented and locally qualified in `codex/abby-provider-ack-receipt`, stacked on the published plans and integrated candidate. The full interval is captured, sent and validated. Existing post-write host success gates remain. Independent review and exact-head CI remain outstanding. |
| 4 Individual booking | Published in draft [PR #460](https://github.com/garthtrickett/abby/pull/460), `codex/abby-provider-ack-individual`, based on receipt correction `92a16e5`. Final online/roster availability follows preparation; exact acknowledgement survives host/review/worker cancellation. Focused, isolated database/process/compiled-location and complete local `npm test` checks passed. Independent review and cloud qualification remain open; cloud jobs have not started because of billing. |
| 5 Native class creation | Implemented candidate in `codex/abby-provider-ack-class`, based on stage 4 `40a51f2`. Exact attendee acknowledgement and final double capacity ordering apply to ordinary/approved-pass creation. Focused, process-loss/privacy and unchanged movement/cancellation regressions passed; corrected compiled cases, final typecheck and manifest checks passed. The full class text pool ended with 2,214 passes, one E2E-353 deadline failure and 225 gated skips; isolated E2E-353 rerun passed. Combined correction qualification remains open. Published in draft [PR #461](https://github.com/garthtrickett/abby/pull/461); independent review and cloud qualification remain open. |
| 6 Earlier-gap qualification | Dispatch-lease omission reproduced for online/roster/class creation and corrected in `codex/abby-booking-dispatch-lease`. Twelve final-read/transport expiry/renewal cases and 124 shared-host regressions pass; typecheck and ordering checks pass. Corrected full `npm test` passed:2,227 main-pool passes,225 gated skips,zero failures/cancellations; separate ordered runner6 passes,zero skips. Full PostgreSQL qualification finished naturally, exit1:2,958 passes,4 failures,1 existing gated skip,zero cancellations; migrations, generation/parity and builds passed, ordered runner not reached. First-failure reproduction remains next after the single corrected Gust7fa diagnostic actually releases its yielded window. The original full class run failed E2E-353; its unchanged isolated rerun passed. Preserve all gaps 1–9 and their remaining engineering/acceptance requirements. |
| 7 Class/pass completion | Pending; staged caller/SAM/operator integration, complete cost admission and broader combinations remain required. |
| 8 Payments | Pending gap 11 specification and implementation, including audit R18/R19 and any necessary approved receipt attachment dependency. The owner selected Stripe Checkout on October16; clinic account/policy acceptance and live activation remain distinct. |
| 9 Outbound | Pending gap 12, audit R20/R21 and contact-policy decisions. |
| 10 Writeback | Pending gap 13, exact permissions/content/storage decisions and audit R08/R22. |
| 11 Combined qualification | Pending. Clinic, mail, native provider, deployment, speech/public-route and eventual carrier acceptance remain distinct gates. Existing real-mail/Twilio deferrals remain. |

The three detailed plans retain the requirements and acceptance matrices. No source merge, deployment, real provider mutation, mail send or Aeva deletion is established by this ledger.

## Preservation evidence

The independently retrieved Aeva tree is `34a642be8da7884b924eb02e7ccae731bd428276`, tree `d77435a1d7cbdcfcceca942f66b8daf625f36ba7`, with 5,431 blobs. Each of the 113 fetched references matched both its remote Git blob hash and the pinned local tree. This resolves the audit's previously unverified remote retrieval for those explicit references; it is retrieval evidence, not a full archive or proof that Aeva tests pass.

Metadata inventory and retrieval manifest are saved outside Abby at `/home/gust/aeva-notes/abby-preservation-20261016/`. The inventory covers 272 registered worktrees, 77 existing directories, 20 dirty existing worktrees and 455 local branches. It found 124 commits unreachable from cached remote-tracking refs; this is not a determination that all 124 are absent upstream or should be retained. The root still has 16 unmerged paths. No dirty source contents, untracked contents, credentials or patient data were archived into Abby.

Before source removal, owners must choose and preserve wanted local-only/staged/unstaged/untracked work and verify its independent recoverability. This remaining preservation dependency does not stop independent Abby engineering.

The planning documents are reviewable in draft [PR #458](https://github.com/garthtrickett/abby/pull/458), based on PR #457's branch so its diff contains only the three added planning documents. Its published-head workflow also failed; the exact receipt implementation needs its own review and CI.

## Receipt foundation

The previous individual writer validated start time and native identity/status bindings but could accept a 201 response without matching the confirmed end time. The end was inspected later by the host. An acknowledgement cannot safely become the success boundary until that gap is closed.

The candidate makes `endsAt` mandatory, rejects invalid/nonpositive/over-eight-hour intervals before quota/provider access, sends `ends_at`, and matches the acknowledged end as an instant. It retains exact patient/business/practitioner/type/marker/ID/active-state matching, bounded response parsing, process-local duplicate protection and response-loss uncertainty. Later observation also matches the interval; inspection cannot substitute a different expected end.

Standalone booking captures the approved offer's end. The earlier embedded Cliniko test host now requires a trusted end in its offer evidence and refuses duration drift between proposal and commit, while retaining its exclusive-permit and conflict-inspection contract. That host is not the transactional owning-diary implementation. The controlled historical probe callers also supply the explicit interval; no live probe was executed.

[ADR 0002](../docs/adr/0002-provider-acknowledged-booking.md), PRD, technical design, glossary and activation/booking notes distinguish the delivered receipt foundation from the still-proposed host success change. Existing D-16 history, other operation contracts, schema and phone-to-ID-only persistence are preserved. There are no new dependencies or settings.

## Executed validation

Commands were run in the isolated receipt worktree; database checks used a newly created disposable PostgreSQL container, not a configured clinic database.

| Command | Observed result |
| --- | --- |
| `npm ci` | Passed. |
| `npm run build:voice-tests` | Passed. |
| `node --test --test-concurrency=2 test/cliniko/booking-write.test.ts test/cliniko/booking-best-effort-edge.test.ts test/cliniko/write-activation.test.ts test/cliniko/standalone-booking.test.ts test/voice/embedded-cliniko-booking-host-call.test.ts` | 59 passed; zero failed, cancelled or skipped. Covers interval/identity/status response mutations, malformed/oversized/invalid-UTF-8 bodies, loss/abort/duplicate cases and existing host semantics. |
| `node --test --test-concurrency=2 test/cliniko/booking-offers.test.ts test/cliniko/booking-native-proof-bracket.test.ts test/cliniko/booking-session.test.ts test/cliniko/intake-booking-session.test.ts test/cliniko/roster-booking.test.ts test/cliniko/long-booking-search.test.ts test/cliniko/reviewed-send.test.ts` | 79 passed; zero failed, cancelled or skipped. |
| `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && ABBY_LEDGER=postgres node --test --test-concurrency=2 test/storage/owning-host-write-contract.test.ts test/cliniko/standalone-booking-postgres.test.ts test/cliniko/standalone-booking-process.test.ts test/cliniko/booking-session-postgres.test.ts test/cliniko/intake-booking-postgres.test.ts'` | 19 passed; zero failed, cancelled or skipped. Includes independent owning-diary transactions, actual booking sender loss, intake composition and PostgreSQL/backup privacy checks. Disposable container was stopped by the harness. |
| Python AST parsing of `phase-0/probes/cliniko_write_probe.py` | Passed syntax check only; no external probe run. |
| First `npm run typecheck` | Failed because the historical TypeScript booking probe omitted the now-required end. Both the probe and its Python caller were corrected. |
| Corrected `npm run typecheck` | Passed. |
| `node --test test/cliniko/standalone-booking.test.ts` after the final fixture assertion | 12 passed; zero failed, cancelled or skipped. The assertion checks that the POST end matches independently held offer evidence. |
| Local Markdown file/heading link verification and `git diff --check` | Passed; 47 local links checked across the plans, progress ledger and ADRs. |
| `node --test --test-concurrency=2 test/cliniko/standalone-booking.test.ts test/cliniko/roster-booking.test.ts` after the shared fixture correction | 43 passed; zero failed, cancelled or skipped. Follow-up runtime qualification exposed that the final assertion used a fixed online offer end for roster choices. It now checks the actual saved confirmed booking review's end, preserving interval verification for either source. Earlier focused results preceded that final assertion; this rerun covers its affected caller paths. |

Full text/browser/PostgreSQL suites and hosted CI are not established by the focused results above.

## Individual booking runtime candidate

Runtime commit `86e09b444818356113af626379de5f165817bcf0` is published in draft PR #460 against `92a16e58b559dbd730ad8f0c50c4f23ecbe57bbb`. Its push run `38872610729` and PR run `38872618610` failed before job execution. Check `116880049725` independently reported the same billing/spending condition. Full local qualification subsequently completed successfully in the tracked `Abby individual complete local suite` user-systemd scope; its exit 0 and results were consumed without restarting after observation timeouts.

The stage 4 delta is based on receipt PR #459, including its separate fixture correction. `ClinikoBookingGuard.authorizeForSend` and concrete/catalogue offer dispatch paths finish proof, file/catalogue approval, SAM settings, shared write-stop checks and native metadata preparation before final availability. The POST budget is claimed before this path; unavailable quota refuses before sending, without a quota wait after the final observation. Online reads retain complete pagination. Roster dispatch retains its complete double calendar observation and performs no later metadata refresh; ordinary protected proposal/reschedule reads keep their existing refresh contract. Immediately before transport invocation, only synchronous original-expiry, local proof/lifetime and abort checks remain.

The individual host returns committed on the exact validated creation acknowledgement and performs no created-row/conflict GET or automatic review closure. A synchronous trusted acknowledgement notification propagates that established result through the host, reviewed-send wrapper and effect worker. The worker accepts only its matching booking action while its dispatch is still pending; late reports cannot reopen a finished dispatch, reports for other operations are ignored, and normal runtime action/version/lease acceptance still applies. Unparsed/held/lost/nonexact responses remain uncertain. No local durable acknowledgement/attempt record, automatic observer, timer extension, slot reservation or additional setting is introduced.

Catalogue, intake-to-booking and normal call-flow adapters forward the trusted notification. At stage 4, native class creation and the other operations retained their existing completion semantics. Product notes and ADR 0002 activated only the individual contract in that candidate; the separate class revision is recorded below. Class movement/pass relinking, rescheduling, cancellation, correction, resend and the earlier embedded/owning-diary contracts remain unchanged by the creation revisions. All thirteen gaps and external acceptance requirements remain in scope. Audit R11 starts with a small [product facts reference](PRODUCT_FACTS.md), kept separate from public FAQs/support advice; its content and 21 cited source/test/ADR files have matching fingerprints, without an automated behavioral or publication attestation.

Executed stage 4 checks:

| Command | Result |
| --- | --- |
| `npm ci` and `npm run build:voice-tests` | Passed. |
| `npm run typecheck` | Passed after fixing missing type imports and replacing a test-only ES2023 array method to preserve the existing ES2022 target. |
| `node --test --test-concurrency=2 test/cliniko/provider-acknowledged-booking.test.ts test/cliniko/booking-write.test.ts test/cliniko/standalone-booking.test.ts test/cliniko/intake-booking-session.test.ts test/text/effect-deadline.test.ts` | 61 passed; zero failed/cancelled/skipped. Covers actual last native observation through transport invocation, real budget exhaustion, local invalidation at dispatch, exact acknowledgement versus pre-parse abort, matching/foreign/late worker results, and registration-to-booking. |
| `node --test test/text/effect-deadline.test.ts` | 6 passed; zero failed/cancelled/skipped, including the new matching-booking acknowledgement boundary. |
| `bash scripts/with-postgres.sh bash -c 'npm run build:voice-tests && npm run db:migrate && ABBY_LEDGER=postgres node --test --test-concurrency=2 test/cliniko/standalone-booking-postgres.test.ts test/cliniko/standalone-booking-process.test.ts test/cliniko/booking-offers-postgres.test.ts test/cliniko/booking-session-postgres.test.ts test/cliniko/intake-booking-postgres.test.ts test/cliniko/intake-booking-process.test.ts test/cliniko/reviewed-send-process.test.ts test/storage/owning-host-write-contract.test.ts test/voice/compiled-location-runner.test.ts'` | 32 passed; zero failed/cancelled/skipped. Includes compiled location/catalogue/TLS-fixture routing, process loss/review discovery, PostgreSQL/backup privacy and independent owning-diary transactions. |
| Full `npm test` via tracked user-systemd scope | Passed, exit 0. Typecheck and compiled voice/dashboard builds passed; main text/composition/admission/voice/Cliniko/portability/contract pool: 2,205 passed, 221 gated skips, zero failed/cancelled; separate ordered runner: 6 passed, zero failed/cancelled/skipped. Runtime source remained fixed at `86e09b4`; `d8977b5` changes only this progress ledger. The 221 skips are not PostgreSQL/browser acceptance evidence. The separate isolated 32-check run above supplies its named database/process/compiled-location coverage. |

The first runtime focused run exposed old policy assertions expecting post-write inspection vetoes and a held conflict-read checkpoint that this flow no longer invokes. They were replaced with explicit acknowledgement/no-GET assertions and a held unacknowledged-create case, retaining lost-response/no-replay coverage. An intake composition test similarly expected conflict/inspection failure to override success; it now distinguishes those acknowledged outcomes from actual review/create failures. Early focused runs failed on these cases; the corrected narrow runs above passed. One broader pre-final run had 121 passes, one outdated intake-policy assertion failure and six database-only skips; those skips are not evidence. The isolated run above subsequently executed all six compiled-location cases. Final full-suite qualification remains separate.

Required manual acceptance before clinic activation remains ordinary and class success with owned native fixtures, exact independent diary inspection after the caller result, and interrupted-review discovery. The individual change specifically needs audible ordinary confirmation on a valid acknowledgement and truthful uncertainty on a lost/nonexact response, without retry or automatic compensation. Check end-of-call behavior and cleanup separately. No clinic call, live provider mutation, real email send or deployment has been performed by this work.

## Native class creation runtime candidate

Stage 5 runtime `de8b1d921ee4d271a167443b6c521d86a187964d` is published in draft
[PR #461](https://github.com/garthtrickett/abby/pull/461),
`codex/abby-provider-ack-class`, based on individual candidate
`40a51f2f6c7182f394dee6b02c1fae66ce316171`. It is not landed or activated.
Exact-head push run `38877593063` and PR run `38877638829` failed with no
executed steps. Checks `116896272685` and `116896427317` independently reported
the account billing/spending condition. This establishes no code failure; no
unchanged workflow was rerun or account/repository policy changed to bypass it.
`ClinikoClassBookingHost` completes class permission, exact played consent,
approved pass/history, proof, metadata, policy/SAM/review and POST quota work
before the final complete double occurrence/attendance observation. The reader's
creation-only `inspectForSend` path leaves ordinary protected reads and movement
bracketing intact. Immediately before transport, synchronous original expiry,
local proof/lifetime and request checks remain; there is no intervening awaited
policy, patient, entitlement or quota work.

`ClinikoClassAttendanceWriter.executeBookingOnce` validates exact bounded native
HTTP 201 attendee/self, patient, occurrence, action marker, explicit active state
and requested case. It synchronously reports the receipt through the existing
host/review/worker result path. Later capacity/duplicate/pass-use races, observer
failure or cancellation cannot turn that established creation into uncertainty.
Lost, nonexact or unparsed responses still cannot confirm or replay. No post-create
GET, automatic compensation, observer job, review closure, extra setting,
dependency or standalone durable patient-bearing state was introduced.

Ordinary creation can acknowledge an omitted optional case property without
claiming no association. A returned unapproved case or undocumented null/empty
shape remains nonexact. A pass response must return its approved case. The official
OpenAPI bundle retrieved again October 16 matches the October 14 SHA256 recorded
in the class notes; it documents no concrete nil-link shape. Class moves still
use their separate native null-filter inspection for required unlinked staging.
Cancellation, movement, compensation and relinking use the existing generic
writer and their operation-specific case/effect inspection. Creation alone proves
neither payment nor atomic capacity/pass exclusion.

The docs/ADRs, product facts and scenario descriptions now reflect this scoped
creation revision. Manifest 1.227 retains all 418 scenarios and their full-call
acceptance limits. Older execution entries retain their historical meaning.

Executed stage 5 checks and active qualification:

| Command | Result |
| --- | --- |
| `npm ci` | Passed; no dependency change. |
| `npm run typecheck` after the process fixtures | Passed again after the additional dispatch-invalidation tests and compiled assertions. The scenario-manifest test also passed (1 check). |
| `node --test --test-concurrency=2 test/cliniko/class-booking-acknowledgement.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-pass-booking-host.test.ts test/cliniko/reviewed-send.test.ts` | 70 passed; zero failed/cancelled/skipped. Exact ordinary/pass acknowledgements, actual SAM ordering, no post-create GET, host shutdown after acknowledgement, current approvals and unchanged review requirements. |
| `node --test test/cliniko/class-booking-acknowledgement.test.ts` after final invalidation cases | 10 passed; zero failed/cancelled/skipped. Also proves local lifetime, proof revocation and original offer expiry after final capacity each prevent transport dispatch. |
| `node --test --test-concurrency=2 test/cliniko/class-attendance-read.test.ts test/cliniko/class-attendance-write.test.ts test/cliniko/class-attendance-case-write.test.ts test/cliniko/class-attendance-staging.test.ts test/cliniko/class-attendance-move.test.ts test/cliniko/class-cancellation-host.test.ts` | 162 passed; zero failed/cancelled/skipped. The original invocation also named two nonexistent files; those were not executed and supply no evidence. The actual cancellation/movement host files ran separately below. |
| `node --test --test-concurrency=2 test/cliniko/class-pass-cancellation-host.test.ts test/cliniko/class-pass-move-host.test.ts test/cliniko/class-pass-movement.test.ts test/cliniko/class-move-host.test.ts test/cliniko/class-move-stages.test.ts` | 148 passed; zero failed/cancelled/skipped. |
| `bash scripts/with-postgres.sh node --test test/cliniko/class-booking-recovery-process.test.ts` | 4 passed; zero failed/cancelled/skipped. Actual SAM owner SIGKILL while review acknowledgement is held, after saved review before clinical dispatch, with create response held, and after committed result before caller confirmation. Independent cold account/type-only discovery finds pending review and makes no provider mutation; actual PostgreSQL/table/backup and process-output canaries remain absent. Disposable native state outlives each killed child; the harness cleans its owned databases, files and server. |
| `bash scripts/with-postgres.sh bash -c 'npm run build:voice-tests && npm run db:migrate && ABBY_LEDGER=postgres node --test --test-concurrency=2 test/voice/class-runner.test.ts test/voice/class-pass-runner.test.ts test/voice/class-pass-cancellation-runner.test.ts test/voice/class-service-runner.test.ts test/cliniko/class-booking-recovery-process.test.ts test/storage/owning-host-write-contract.test.ts'` | First run: 48 passed, 2 failed, zero cancelled/skipped. Both failures were old creation-veto assertions for post-send extra pass use/overcapacity; the exact acknowledged result was committed. Cancellation, multiple-service, process/privacy and owning-diary cases passed. The corrected two-file rerun below preserves exact acknowledgement/no-GET/no-replay assertions. |

| `bash scripts/with-postgres.sh bash -c 'ABBY_LEDGER=postgres node --test --test-concurrency=2 test/voice/class-runner.test.ts test/voice/class-pass-runner.test.ts'` | 22 passed; zero failed/cancelled/skipped. Exact ordinary/pass creation confirms despite post-send overcapacity/extra use, with no post-create native GET; outcome queries retain success and do not repeat the create. Pre-send denial, lost-response uncertainty and separately inspected cancellation remain covered. |
| Full combined `npm test` via tracked user-systemd scope | Completed exit 1. Typecheck and builds passed; main pool: 2,214 passed, 1 failed (E2E-353 new-patient service-catalogue voice menu deadline), 225 gated skips, zero cancelled. The separate ordered runner was not reached. Isolated unchanged E2E-353 rerun subsequently passed (one top-level test covering its 16 cases). This is not a full-suite pass; the earlier stage 4 full pass does not qualify this delta. |

Early focused runs similarly found assertions expecting post-create inspections;
they were corrected to distinguish exact creation truth from nonexact/lost
responses. A new pass ordering test initially stopped at the existing quota-wait
notice; it now follows that notice, renews the ordinary lease and obtains a fresh
affirmation within the original offer/proof expiry. No budget limit or timeout
was weakened. Full composed qualification, independent review, cloud execution
and all actual clinic/provider/operator acceptance remain separate open gates.

## Composed dispatch lease correction

Runtime `94fd49e2ac5d250cf8fafb5d85d35a4d5b683370` is published in draft
[PR #462](https://github.com/garthtrickett/abby/pull/462), based on class `ae15000`.
Push run `38880747568` and PR run `38880804698` ended before execution; inspected
PR check `116906810004` reported account billing/spending limits with no job
steps. This supplies no code-failure verdict or successful cloud qualification.

Stage 6 source review found that booking preparation validated the current
session lease, but final synchronous dispatch checks retained only patient/offer
expiry and local proof/lifetime. A lease could expire during the last native read
while the proof and offer remained valid. Actual SAM reproduction in the
isolated `codex/abby-booking-dispatch-lease` worktree based on class `ae15000`
sent one POST in each expired online/roster/class case; their observed-renewal
controls passed. The initial six-case reproduction had three failures and three
passes, all without skips. This is a pre-send correctness gap, independent of
the later exact-acknowledgement success policy.

The correction retains the exact lease deadline from the last validated SAM
snapshot before final availability/capacity. Individual dispatch binds it to its
prepared request; the class owner holds its own captured deadline. The deadline
must remain live both when the native read returns and at transport invocation.
An already observed renewal supplies its newer deadline; an unobserved renewal
cannot extend this captured send window. No extra ledger/provider/policy read,
new timer, remote-stop replica, schema, dependency, setting or durable
patient-bearing state is introduced. Other operation contracts and established
acknowledgement results retain their semantics.

Executed correction checks:

| Command | Result |
| --- | --- |
| `npm ci` | Passed; no dependency change. |
| `node --test --test-concurrency=2 test/cliniko/booking-dispatch-lease.test.ts test/cliniko/provider-acknowledged-booking.test.ts test/cliniko/class-booking-acknowledgement.test.ts` | First corrected version:24 passed, zero failed/cancelled/skipped. Includes the original six lease cases plus actual no-async-preparation ordering and acknowledgement/abort boundaries. |
| `node --test test/cliniko/booking-dispatch-lease.test.ts` after adding the transport boundary | 12 passed, zero failed/cancelled/skipped. Online, roster and class each refuse expiry after the native read and immediately before transport; observed renewals succeed at both points; no replay occurs. |
| `node --test --test-concurrency=2 test/cliniko/standalone-booking.test.ts test/cliniko/roster-booking.test.ts test/cliniko/intake-booking-session.test.ts test/cliniko/class-booking-host.test.ts test/cliniko/class-pass-booking-host.test.ts test/cliniko/reviewed-send.test.ts test/text/effect-deadline.test.ts` | 124 passed, zero failed/cancelled/skipped. |
| Initial `npm run typecheck` after the source correction | Passed; the final-source typecheck subsequently passed inside the completed combined suite after the expanded test file. |
| `node --test test/contract/scenario-manifest.test.ts` | Passed, 1 check; manifest1.228 retains418 IDs and full-call limits. Current individual creation assertions no longer prescribe the superseded inspection veto; the earlier embedded E2E-266 contract is unchanged. |
| `node --test test/voice/intake-service-catalogue.test.ts` on unchanged class source after the full-run E2E-353 failure | Passed, one top-level check covering its16 internal cases. No deadline, concurrency, assertion or source changed. The full-run deadline failure remains recorded, not dismissed as a proven environmental issue. |
| Corrected full `npm test` | Passed, exit0, in tracked user-systemd scope `Abby corrected booking complete local suite`, log `be9df097-1792142756182.log`. Natural terminal consumed after21m10s; wrapper1087159 is absent. Final-source typecheck and builds passed; main pool:2,227 passed,225 gated skips,zero failures/cancellations; separate ordered runner:6 passed,zero failures/cancellations/skips. E2E-353 passed in this full run. Default concurrency and original deadlines were retained; runtime source stayed fixed at94fd49. Gated skips do not establish PostgreSQL/browser acceptance. |
| Complete PostgreSQL qualification | Failed, natural exit1 after46m55s, tracked `Abby corrected booking full PostgreSQL qualification after Gust release`, log `be9df097-1792144314355.log`. Migration up/down/up, generation/parity and voice/dashboard/admin/availability builds passed. Main pool:2,958 passed,4 failed,1 existing C-LIVE-40 skip,zero cancellations; separate ordered runner was not reached. Runtime source remained94fd49; documentation headf01b9d2. Failure details and the next compute handoff are recorded below. |

The original PostgreSQL queue was intentionally stopped before any test began
when the lease omission was reproduced. Its stopped wrapper is shown as
ORPHANED on the work board and supplies no test result. A replacement queue
waiting for the original class suite ended exit1 when that prerequisite failed;
it also ran no PostgreSQL tests. The corrected-source queue then waited for the corrected suite. A subsequent
compute-coordination request intentionally stopped only that prerequisite waiter
before any PostgreSQL test began; the original local suite subsequently finished
naturally, exit0. The handoff was published on the shared work board at09:47UTC.
No new heavy Abby job or automatic restart was queued.
Those prerequisite-waiter outcomes establish no PostgreSQL result. The later
actual database qualification is recorded below, separately from their termination.

ADRs retain the same decision; this fixes an existing lease invariant. Product
facts and their31 directly cited source/test/ADR fingerprints are refreshed.
Independent review, exact-head cloud qualification, broader earlier-gap
engineering and all external acceptance remain open. No full integration,
landing, clinic activation or Aeva deletion is claimed.

## Gap 11 provider selection

On October16 the owner selected Stripe Checkout after the provider recommendation.
The proposed integration uses a separate hosted Checkout Session for each approved
deposit/payment request, bound to the exact clinic account, action, amount,
currency and authorized recipient. Use verified payment evidence for paid
status; a completed browser redirect or delivered link is not payment proof.
Cliniko appointment status, payment, delivery, receipt and expiry remain separate.
Expiring a checkout does not prove an appointment cancellation, and late payment
does not restore a cancelled appointment.

Current primary references checked: [hosted Checkout](https://docs.stripe.com/payments/checkout),
[Checkout Session status](https://docs.stripe.com/api/checkout/sessions),
[session expiry](https://docs.stripe.com/api/checkout/sessions/expire),
[webhooks](https://docs.stripe.com/webhooks) and
[receipts](https://docs.stripe.com/receipts).
This records the owner's provider selection. It does not establish clinic account/terms
acceptance, a payment implementation, approved financial storage, connected-account
setup or live money movement. Refine the exact payment/provider-owned recovery contract under
stage 8 before implementing it; retain the standalone privacy rule and all
R18/R19 adversarial cases. Current booking/class qualification continues first.

## Review, acceptance and remaining limits

Author review compared the receipt delta with booking step 1: exact interval evidence is added without changing final-availability ordering, native class logic, host post-write gates or shared cancellation/rescheduling/correction/resend semantics. An incomplete/mismatched creation acknowledgement now remains uncertain even if a later GET could supply the missing interval; this is the receipt requirement in the owner's instruction to execute the booking plan. No new caller wording, clinic setting or notification is introduced. The owning-diary proof remains separately executed rather than inferred from the earlier embedded test host. Independent review of the exact published candidate remains outstanding.

No live clinic test is needed to claim this narrow synthetic receipt foundation. Before the later booking policy is activated, propose separately authorized ordinary/class success and interrupted-review discovery tests using owned provider fixtures; check audible result, independent native state and cleanup separately. A manual diary read is acceptance evidence and must not become a runtime success gate again. The clinic must accept the remaining external races and recovery workflow.

GitHub's exact PR #457 job `116295932632` reported no steps and the annotation: “The job was not started because recent account payments have failed or your spending limit needs to be increased.” No code failure was established by that job. Only the account owner can resolve that condition; no billing, workflow, test threshold or repository policy was changed to bypass it. Local engineering can continue, but required cloud qualification and landing remain open.

## Complete PostgreSQL result and next diagnostic

After Gust643f naturally terminated and released its window, fresh Abby guards
admitted the isolated database job at09:51:54UTC. Runtime94fd49 stayed fixed
throughout; f01b9d2 contains documentation only. The job finished naturally,
exit1, after46m55s. The authoritative work exit file and `work wait` were
consumed; wrapper1140136 is absent. No test was interrupted.

Command inside the tracked user-systemd scope:

```sh
bash scripts/with-postgres.sh bash -c 'npm run db:migrate && npm run db:migrate -- down && npm run db:migrate && npm run db:generate && git diff --exit-code -- src/storage/generated && ABBY_LEDGER=postgres npm run test:postgres'
```

Migration up/down/up, generation/parity and builds passed. The main test command
reported2,963 tests:2,958 passes,4 failures,1 existing C-LIVE-40 skip and zero
cancellations. The ordered runner follows `&&` and did not execute. This is
failed whole-suite qualification, independently of the earlier passing `npm test`.

| Failed scenario | Current evidence |
| --- | --- |
| E2E-358 first-time South registration then offline approved female member booking | `compiled-roster-coverage.test.ts:62`: clinical runner response timed out after the patient create succeeded, during booking-time request/selection. |
| E2E-380 cancelled-content resend | `confirmation-resend-content-runner.test.ts:16`: private runner prompt timed out. |
| E2E-353 new-patient service variants | Booking-menu diagnostics reached the existing15-second deadline after registration and returned `invalidTransition`; variants are retained in the original aggregate error. |
| E2E-354 first-time initial service/gender integration | `integrated-clinical-runner.test.ts:48`: clinical runner response timed out. Existing-patient sibling passed. |

The first failure needs an unchanged isolated reproduction before attributing
any result to machine load or changing code. Original deadlines, assertions
and full-suite concurrency remain intact. After the coordinated compute window
releases, start with the actual E2E-358 file in fresh isolated PostgreSQL and
the same source/build, then adapt the next diagnostic to that result. No
unchanged full-suite rerun is queued.

The tracked notifier naturally finished exit0 and its Paseo send acknowledged
`status: sent` to coordinator `b5c49e2b-2177-4cbe-98f3-46387cbbe2dd` at10:38:50UTC.
The next heavy Abby window is held/yielded to ONE corrected frozen Gust7fa76986
diagnostic, subject to that lane's own fresh guards and actual start/terminal
release. Abby heavy diagnostics, builds and database jobs remain unqueued
until its actual release and Abby's own fresh checks. Light source work can
continue. This note neither starts a compiler nor uses an estimated handoff.
