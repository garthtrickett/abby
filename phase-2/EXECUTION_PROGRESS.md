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
| 6 Earlier-gap qualification | Dispatch-lease omission reproduced for online/roster/class creation and corrected in `codex/abby-booking-dispatch-lease`. Twelve final-read/transport expiry/renewal cases and 124 shared-host regressions pass; typecheck and ordering checks pass. Corrected full `npm test` passed:2,227 main-pool passes,225 gated skips,zero failures/cancellations; separate ordered runner6 passes,zero skips. Full PostgreSQL qualification finished naturally, exit1:2,958 passes,4 failures,1 existing gated skip,zero cancellations; migrations, generation/parity and builds passed, ordered runner not reached. Gust7fa released naturally, exit0; unchanged first-file and concurrent four-file PostgreSQL reproductions passed4 and9 tests respectively, with overlap, while the failed full-suite timing cause remains unproven. The reader/foundation typecheck is tracked separately. The separate correction/resend reader-kind fix passes focused gateway checks; its typecheck now passes; independent and database/cloud qualification remain open. The original full class run failed E2E-353; its unchanged isolated rerun passed. Preserve all gaps 1–9 and their remaining engineering/acceptance requirements. |
| 7 Class/pass completion | Qualified foundation is published in draft PR #465 (`2593364`, runtime `809e993d`), with its full typecheck,35 focused core/registry and76 synthetic native/review passes. A separate unpublished native caller follow-on now connects actual ordinary/pass stages, same-subject renewal, current captured-policy terms and distinct played phase effects through shared text/admitted-flow/VoiceSession dispatch; its final light checkpoint passes79 tests. Complete cost admission, operator resolution, mixed/concurrent/process/database/privacy and full typecheck of the follow-on remain open. Failed parent PostgreSQL and zero-step cloud runs are retained; no clinic activation is established. |
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

## Product-fact drift qualification

Stage 6 audit R11 review found that the small operator reference had manually
verified fingerprints but no normal-gate check. The isolated
`codex/abby-product-facts-guard` follow-up, based on dispatch correction `94fd49`,
adds `test/contract/product-facts.test.ts`. The existing Node test globs include
it without a script, dependency, scenario-ID or runtime change. It verifies the
fact-content hash, matching review date, unique fact IDs, exact coverage of
directly cited repository files and each source hash. Source removal or a missing
fingerprint cannot silently pass. It checks drift and does not certify behavior,
deployment, clinic acceptance or published support advice.

`node --test test/contract/product-facts.test.ts` passed with one check and zero
failures/skips. Tracked `Abby product facts guard drift qualification` completed
exit0 in log `be9df097-1792143530413.log`: the current reference passed,
deliberately stale source hash, omitted source hash and changed fact content
each failed for the expected reason, and the restored reference passed. All
temporary edits were restored. `git diff --check` passed. These checks use only
Node builtins and repository files; no dependency install, compiler, browser or
database ran in this follow-up.

The corrected booking suite finished naturally, exit0, against fixed runtime
`94fd49` in its original worktree. The new guard was not included in that suite.
This follow-up is rebased onto documentation-only `f01b9d2`, which records its
terminal and the next heavy window yielded to Gust. The next heavy Abby job
remains held for that single diagnostic and its actual terminal release.
Full PostgreSQL/cloud qualification and independent review remain outstanding.

The drift check was initially published as `97dda69a43e3fc070bd25cd2c710dff5e1c88c00`
in draft [PR #463](https://github.com/garthtrickett/abby/pull/463). Its exact-head
push38882031995 and PR38882064861 had no executed steps; PR check116910912400
independently reported account billing/spending limits. Rebased-head cloud
qualification remains required; no green result is inferred from the local check.

## Correction and resend result-reader kinds

Stage6 review of the shared result readers found a stale four-kind allowlist in
`src/reference/call-review.ts`. Actual SAM `patientUpdate` and
`confirmationResend` actions could reach committed/uncertain state, but scoped
`calls.read.v1` and its dependent `calls.outcomes.v1` reporting returned
`storageCorrupt`. The isolated `codex/abby-call-review-action-kinds` candidate,
based on product-facts guard `afaff89`, replaces that list with an own-property
map checked against every `ActionState["kind"]` by TypeScript. Existing DTOs and
capability schemas already include both operations. This fixes result reading;
it adds no write, permission, notification, durable state, dependency or setting.

Actual SAM plus scoped gateway reproduction failed all4 new cases before the
fix, with `storageCorrupt`, in `be9df097-1792145565092.log`. After correction:

- `env ABBY_LEDGER=memory node --test --test-concurrency=1 test/text/call-review-action-kinds.test.ts test/text/call-review.test.ts test/text/call-outcome-report.test.ts test/text/patient-correction.test.ts test/text/confirmation-resend.test.ts`:16 passed,zero failures/cancellations/skips, `be9df097-1792145600243.log`.
- Final extra invalid-kind controls and registry checks: `env ABBY_LEDGER=memory node --test --test-concurrency=1 test/text/call-review-action-kinds.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts test/contract/product-facts.test.ts`:7 passed,zero failures/cancellations/skips, `be9df097-1792145662377.log`. These runs overlap; do not sum them as independent cases.
- `git diff --check`:passed. Existing same-lock installed dependencies are read through a worktree symlink; no dependency install, compiler, database or browser ran for this focused follow-up.

The gateway cases cover committed/uncertain truth, redaction of private request,
proof/patient/host references, foreign-scope refusal, corrupted/unknown/prototype
kind refusal and absence of another host write. Manifest1.229 keeps418 IDs and
adds the witness to E2E-362/E2E-373 without promoting full-call evidence.
Full typecheck, isolated PostgreSQL qualification of this delta, independent
review and exact-head cloud checks remain open. The earlier complete booking
suite and failed PostgreSQL job do not qualify these later source changes.
The database job finished naturally and its notifier acknowledged terminal
release at10:38:50UTC; the next heavy window remains held for the corrected
Gust7fa diagnostic and its actual release. Staged-class source
preparation remains separate and unpublished. All thirteen gaps remain active.

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


## Result-reader fixture type qualification

The fixture passed runtime checks but initially failed `npm run typecheck`:
`FakeHost` omitted the booking resolver required by `TextReception`. The first
sequential job, log `be9df097-1792148386294.log`, naturally exited 2. The next
job exposed the other required port, `readKnowledge`, and naturally exited 2,
log `be9df097-1792148558873.log`. The staged foundation check did not run in
either job.

The corrected fixture explicitly satisfies the complete `TextHost` interface,
retains the actual SAM host and mutation counters, and throws if result reading
attempts an unrelated booking or knowledge read. No production port or type
assertion was added. Full `npm run typecheck` and all four actual gateway memory
cases passed in `be9df097-1792148713720.log`, with source inputs unchanged.
That combined job subsequently exited 2 on the separate unpublished staged
foundation; its later errors do not change this reader typecheck pass.

After Gust7fa released, unchanged parent-runtime PostgreSQL diagnostics passed
four cases in the original first-failure file and nine overlapping cases with
all four previously failing files at original concurrency 4. Logs are
`be9df097-1792148090945.log` and `be9df097-1792148234292.log`. They do not
establish the original timing cause or qualify this reader delta. The failed
whole PostgreSQL suite remains failed; reader PostgreSQL qualification,
independent review and required cloud checks remain outstanding. No landing
or clinic activation is claimed.

## Staged movement source foundation, E2E-419

`codex/abby-staged-class-caller` contains unpublished source preparation above
the correction/resend reader fix. Its local prerequisite is `cd9b4ca`, which
also completes the reader fixture ports after the PostgreSQL-outcome
documentation rebase. The first rebase preserved all 33 then-changed foundation
files byte-for-byte. The prerequisite runtime source is identical to published
draft `846cc76`; its test fixture now satisfies the complete gateway host
interface. These rebases are not new cloud qualification. No admitted native staged caller
route or clinic activation is claimed.

The core now separates partial observations, pending live-owner continuation,
complete movement, inspected restoration and review. Public progress carries
fixed attendance/association facts; native identifiers, proof references and
resume capabilities stay out of the projection. A pending move counts as
unresolved. A terminal label contradicting those facts is refused.

Each next phase has a distinct digest/effect and separately played readback
of its exact immutable targets and terms. Current same-patient proof may be
reused without extending its expiry. Changed proof, conversation revision,
policy, lease, call or continuation cannot reuse the old confirmation.
Ending, identity denial, interrupted playback and unknown sends retain
inspected effects while retiring further stage authority. A host without a
live continuation owner cannot fall back to the initial write. The actual
effect-recovery entry point preserves uncertainty after a possibly-sent phase;
a later generic leg exact-commit cannot establish the joint move.

Native source preparation also lets explicitly staged ordinary movement use
the existing physical 180-request allocation and separate 30-second stages,
without an invented membership leg. Its separately versioned review compresses
the complete no-pass request within the existing 1,000-character summary bound.
The existing pass tuple format and legacy ordinary JSON remain intact.
Malformed/corrupt/oversized payloads and header downgrade are refused.

| Actual focused command | Result and scope |
| --- | --- |
| `env ABBY_LEDGER=memory node --test --test-concurrency=1 test/text/class-movement-progress.test.ts test/text/class-movement-receipt.test.ts test/text/class-movement-consent.test.ts test/text/class-movement-sam.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts` | 33 passed,zero failures/cancellations/skips, log `be9df097-1792147098375.log`; 31 pure/memory SAM contracts plus 2 registry checks. No compiler, browser, database or live provider ran. |
| `env ABBY_LEDGER=memory node --test --test-concurrency=1 --test-name-pattern='^(staged no-pass\|explicit identity denial)' test/cliniko/class-attendance-move.test.ts test/text/class-movement-sam.test.ts` | 6 passed,zero failures/cancellations/skips, log `be9df097-1792146372618.log`; 5 ordinary native synthetic cases plus 1 overlapping identity-denial SAM case. Do not sum overlapping runs. |
| `env ABBY_LEDGER=memory node --test --test-concurrency=1 test/text/effect-deadline.test.ts test/text/call-review-action-kinds.test.ts test/text/call-review.test.ts test/text/call-outcome-report.test.ts` | 14 passed, zero failures/cancellations/skips, log `be9df097-1792147584023.log`; shared booking acknowledgement/deadline and correction/resend result-reader regressions. |
| Terminal contradiction reproduction and refined reader integration | The new contradiction test first failed in `be9df097-1792146835769.log`; corrected full contracts above and 2 focused projection/SAM checks in `be9df097-1792146911864.log` passed. |

Early ordinary staged tests failed because the synthetic recall omitted its
required self link, then because cross-service review JSON exceeded the bound.
The fixture now supplies exact native ownership metadata; the separate staged
format preserves all context without increasing the bound. An initial denial
test wrongly expected a rejected turn; the existing monotonic identity-denial
contract instead accepts later input only as another denial. The corrected
assertion checks no stage effect/write and retained native truth. These
failures remain in logs `be9df097-1792146004643.log`,
`be9df097-1792146233933.log` and `be9df097-1792146347703.log`.

Manifest 1.230 adds E2E-419 as text-only evidence, 419 stable IDs and planned
full-call evidence. The complete foundation typecheck and cited product-fact
review/drift contract now pass, with exact qualification recorded below.
Broader synthetic and database/process qualification remains separate.
The native admitted caller and private renewal route, new-host operator
resolution, complete permission/proof/native request-cost bounds, quota-window
serving, mixed catalogue/correction/no-pass/pass combinations and actual
process/database/backup acceptance still need implementation and qualification.
All thirteen gaps remain active. The failed parent PostgreSQL suite and
Gust7fa compute handoff remain separate from this source preparation.

Read-only cleanup verification after the database terminal found no active
`abby.phase0.probe=true` containers created by this run. The remaining labelled
containers predate this run by days; no container or other agent's process was
stopped. The separate light regression job finished naturally before the next
compute status check. No heavy Abby diagnostic was started.

## Post-handoff unchanged PostgreSQL diagnostics

The single corrected Gust7fa compiler finished naturally, exit0, with actual
terminal/release confirmed around10:53UTC. Fresh board/agents/source/PID and
resource guards then admitted each Abby job separately. The failed-suite
runtime94fd49 and compiled fixtures built09:52:39 stayed unchanged; no source
fix, deadline/assertion relaxation or concurrency change preceded these runs.

| Diagnostic | Actual result |
| --- | --- |
| `bash scripts/with-postgres.sh env ABBY_LEDGER=postgres node --test --test-concurrency=4 test/voice/compiled-roster-coverage.test.ts` |4 passes,zero failures/cancellations/skips; natural exit0 after45s, log `be9df097-1792148090945.log`. Fresh start10:54:51UTC had5,010,508KiB available and PSI0. |
| Same command with all four previously failing files: `compiled-roster-coverage`, `confirmation-resend-content-runner`, `intake-service-catalogue`, `integrated-clinical-runner` |9 passes,zero failures/cancellations/skips; natural exit0 after1m, log `be9df097-1792148234292.log`. Fresh start10:57:14UTC had5,025,092KiB available and PSI0. Original concurrency4 retained; no second heavy job overlapped. |

These runs overlap and do not prove the original timing failures were caused
by the environment. Complete PostgreSQL qualification remains failed, and
there is no unchanged full-suite rerun queued. The later reader/staged source
is different and needs its own qualification. Its sequential typecheck was
admitted after these terminals with fresh guards at10:59:46UTC,
MemAvailable5,013,000KiB/PSI0, wrapper1228735, log
`be9df097-1792148386294.log`; an observation timeout is not its terminal.

The first sequential typecheck finished naturally, exit2, after1m14s, log
`be9df097-1792148386294.log`. Its first reader check reported TS2345 at
`test/text/call-review-action-kinds.test.ts:31`: the SAM fixture's `FakeHost`
lacked `TextReception`'s required booking resolver. The staged check did not
run. This was a real typecheck failure despite the earlier runtime test passes.
The second sequential run, wrapper 1229496, also finished naturally with
exit 2 after 57 seconds, log `be9df097-1792148558873.log`. Adding only the
booking resolver exposed the other required `TextHost` port, `readKnowledge`.
The foundation check again did not run. Both were actual fixture type errors;
runtime-only passes did not establish the gateway interface.

The final fixture explicitly satisfies the complete `TextHost` type. It retains
the actual SAM host and adds booking/knowledge readers that throw if invoked,
preserving the no-extra-write assertion without a cast or production change.
The third sequential job, wrapper 1230028, finished naturally with exit 2 after
2m03s, log `be9df097-1792148713720.log`. The reader's full `npm run typecheck`
and all four actual gateway memory tests passed. Source inputs remained
unchanged during the run. The subsequent foundation typecheck reported three
sites: union narrowing in `uncertainClassMovement`, a potentially missing
linked action during played consent, and a test assigning a readonly field.

Those three sites now use explicit pending/review narrowing, an explicit linked
action guard and immutable test fixture replacement. The same 31 movement/SAM
contracts plus two registry checks passed after correction, natural exit 0,
log `be9df097-1792149126383.log`. The corrected foundation full typecheck has
not yet run. No type assertion, deadline or runtime assertion was weakened.

Actual terminal/release was checked and sent to the Gust coordinator at
11:08:28 UTC. Abby has yielded the next heavy slot to ONE frozen Gust e252461b
diagnostic, conditional on that lane's four fresh post-release samples and
immediate source/tool/limits/live/agents checks. No Abby typecheck, build or
database job will start until its actual terminal/release and fresh Abby
guards. Light source work continues; elapsed estimates grant no launch.


## Foundation product-fact review

Reviewed the changed host, worker, runtime and transition against the existing
booking facts. The booking-only active-dispatch acknowledgement callback,
matching action checks, original dispatch-lease/transport ordering and ended
call behavior are preserved. Staged movement uses its own effect branch and
cannot promote a generic leg acknowledgement or reconciliation to joint move
completion. The unchanged booking claims remain scoped to creation.

The operator reference now states the tested partial-truth, played-consent,
redaction and fresh-host limits of the foundation, and explicitly leaves the
native serving/renewal and operator routes unfinished. Its reviewed content
and directly cited sources have refreshed fingerprints. The 33 focused
movement/registry checks passed after the three type corrections; the prior
14 shared booking deadline/reader/report checks passed before those narrow
corrections. The content/fingerprint contract passed, natural exit 0, log
`be9df097-1792149219238.log`, command `node --test
test/contract/product-facts.test.ts`. Source review and that drift guard do not
establish broader qualification.


At 11:15 UTC the Gust lane still had no compiler and remained below its own
unchanged admission floor. Abby reported that one corrected foundation
`npm run typecheck` is ready and requested an explicit release/requeue of the
unused Gust-next hold. The request itself grants no launch; until explicit
agreement, the existing hold continues. No Abby heavy process is live or
queued. The separate deterministic booking-menu refusal diagnosis uses only
light memory tests in its own worktree.


## Corrected foundation typecheck terminal

The Gust coordinator explicitly released the unused hold at 11:16 UTC for
exactly one Abby foundation typecheck. Fresh board/agents/source/PID and
resource guards admitted the job at 11:17:23.870854 UTC, with MemAvailable
4,514,328 KiB and PSI full_avg10 0. Work `1792149443641`, wrapper `1233207`,
ran `npm run typecheck` in user-systemd scope
`run-r3df4832229b04bf7b2a746e33d96573f.scope`.

The job finished naturally at 11:18:29.663639 UTC, exit 0, after 1m06s.
All 1,149 source inputs were unchanged before/after. The qualified source
patch SHA-256 above prerequisite `7b64542` was
`f5e57457bf64a55c19168a2dd4ff93da22856698ebe4b94d2773a46daf396990`.
The actual terminal and absent wrapper/Python PIDs were independently checked
at 11:19:05 UTC and sent directly to the coordinator. Gust's one e252 attempt
is requeued with that conservative post-release sampling cutoff. No follow-on
Abby heavy job is queued; source/docs and small synthetic contracts continue.

The foundation was then rebased onto qualified reader fixture commit `cd9b4ca`.
All 37 non-conflicting changed file hashes and all 1,149 qualified typecheck
source inputs matched exactly. The execution-ledger append conflict retained
both evidence sections; no source conflict or assertion change occurred.
Backups and the pre-rebase stash remain retained. A ref/documentation change
is not a new cloud or database qualification.


The broader light synthetic native/review command also passed all 76 tests,
zero failures/cancellations/skips, natural exit 0 after 10 seconds, log
`be9df097-1792149676757.log`:

```sh
env ABBY_LEDGER=memory node --test --test-concurrency=1 test/cliniko/class-attendance-move.test.ts test/cliniko/class-move-stages.test.ts test/cliniko/reviewed-send.test.ts
```

These in-process synthetic fetch contracts cover legacy ordinary movement,
ordinary/pass staging, exact review encoding, quota windows, compensation,
concurrent advances and reviewed-send behavior. No compiler, database, browser,
process build or real provider ran. This evidence does not supply the unfinished
native serving/renewal/operator route or whole-process qualification.


## Refinement: startup admission, active lease and terms expiry

The next source review found two distinct expiry defects in the unpublished
foundation. The previous full typecheck pass remains evidence for its frozen
source, not this later revision.

First, the admission deadline bounds startup activation. Existing core
`sessionActivated`/`admissionExpired` transitions enforce it while the call is
starting; an active call instead follows its renewable session lease. The
foundation incorrectly also limited later phase consent by that old startup
deadline. A real admitted/activated/renewed-session regression failed before
correction, log `be9df097-1792149846165.log`. The refined test renews the same
session at 20, 40 and 60 seconds and checks consent at 65 seconds, after a
full quota window. The original startup deadline stays unchanged; ending or
lease expiry still denies consent, and no proof expiry or mutation is extended.
Malformed admission metadata remains refused.

Second, current patient proof must not extend independently approved terms.
The new terms-expiry regression failed before correction, log
`be9df097-1792149946152.log`. Phase consent is now also bounded by valid,
unexpired movement terms; proof/lease renewal cannot revive expired terms.
The original immutable terms and targets are retained. The actual native
caller and operator paths remain unfinished; no terms-refresh authority is
invented here.

Corrected core/SAM/registry contracts passed 35 cases, zero failures,
cancellations or skips, natural exit 0, log
`be9df097-1792149970882.log`, using the six-file focused command above.
This comprises 33 memory contracts plus two registry checks and overlaps the
earlier 33-case runs. The directly cited consent source/witness and the new
operator fact were reviewed and their fingerprints refreshed. The revised
foundation needs its own full typecheck in the next explicitly coordinated
Abby heavy slot; no compiler or database job is queued under the Gust hold.


The source-preserving rebase facts/manifest/trace checks passed three cases,
log `be9df097-1792149759056.log`. After the expiry refinements and explicit
operator-fact review, `node --test test/contract/product-facts.test.ts` passed
one case, log `be9df097-1792150015166.log`. Both naturally exited 0 with no
failures/cancellations/skips. These are overlapping drift/registry checks,
not extra whole-process acceptance.


## Final refined foundation typecheck

The second explicit Gust swap authorized exactly one full typecheck of frozen
foundation `809e993dde67af7fab4dad27a719cabbea9808cc`; the separate booking-menu
candidate was excluded. Fresh board/agents/source/PID checks and MemAvailable
4,573,732 KiB/PSI full_avg10 0 admitted work `1792150300641` at
11:31:40.937670 UTC, wrapper `1236718`, user-systemd scope
`run-rd393d330ae8c4f128975be43de77d356.scope`.

`npm run typecheck` passed and finished naturally at 11:32:39.278399 UTC,
exit 0, after 58 seconds, log `be9df097-1792150300641.log`. All 1,149 frozen
source inputs stayed unchanged and the tracked tree was clean. At 11:32:58 UTC
the authoritative exit file, absent wrapper/Python PIDs and successful
`work wait` were checked and the terminal/release sent directly to the Gust
coordinator. That conservative new cutoff replaces 11:19:05 for its one
requeued e252 attempt. No follow-on Abby heavy job is queued.

This full typecheck qualifies the two expiry refinements as well as the
original observation/receipt/consent foundation. It does not supply the
unfinished native serving route, whole database/process acceptance or cloud
qualification. Later documentation commits preserve the exact qualified
source inputs. All thirteen gaps remain active.

The prerequisite facts guard `b65c1a2` and reader correction `cd9b4ca` were
published through their existing draft PRs. Exact-head push/PR runs
38894023352/38894028876 and 38894026366/38894030572 respectively failed before
all four jobs started (zero steps). Typecheck checks 116950100968 and
116950106907 explicitly report the account billing/spending startup failure.
No source failure or cloud qualification follows, and no billing/workflow
configuration was changed. Both PRs remain draft.


## Native movement owner follow-on: unpublished source checkpoint

Worktree `abby-class-staged-native-owner`, branch
`codex/abby-class-staged-native-owner`, starts at published foundation
`25933648ba7f33e6582ca4de50c8707561424f59`, draft
[PR #465](https://github.com/garthtrickett/abby/pull/465). Its new source is
unpublished and has not run a full typecheck. The foundation's successful
frozen809 typecheck does not qualify these changes. The separate booking-menu
candidate `2cf1d51` remains outside this tree and awaits its own typecheck.
No follow-on heavy job is queued under the Gust e252 hold.

The preparation now makes fresh same-contract terms evidence explicit in phase
consent. The private host must issue it after current policy checks; version
and approved wording must match the immutable original request, while its
separate expiry bounds the new played consent. Patient-proof renewal cannot
renew terms. A terms-evidence regression failed before this interface existed,
log `be9df097-1792150560839.log`; corrected terms/SAM checks passed in
`be9df097-1792150593048.log`. There is no connected native terms issuer yet.

`ClassMovementVerifier` owns actual rescheduling-verifier succession for one
private subject. It reuses a live proof; when expired, it invokes `renewOnce`
before a protected read can clear the old source. Dedicated private code entry
establishes only a fresh proof. It cannot redirect an old proof object, adopt
a different patient, reset exhausted answers or grant phase consent. An
interrupted held answer retires the successor and ignores late success.
Five actual fixture cases pass, including real session renewals across the
five-minute proof expiry. No ordinary caller turn or durable queue carries
code/contact/proof values.

An independent `quotaStaging.version` may be captured in the owner-controlled
move policy. Pass staging must match the separately approved membership
contract. The first two schema tests correctly failed before support existed,
log `be9df097-1792151018116.log`. The next run also failed because the test
tried to hot-load edited content through a captured source, log
`be9df097-1792151044470.log`. The existing source/membership hash fence was
correct. The refined fixture captures a fresh policy and asserts the old
owner stays revoked; both cases pass in `be9df097-1792151121605.log`. No
production revocation guard was relaxed.

A real SAM regression also reproduced a ready phase surviving new caller
speech after affirmation, log `be9df097-1792151324908.log`. New speech now
retires ready/dispatched movement authority. A new nonaffirmative turn also
retires a dispatched phase. An unsent phase is canceled; a possible send keeps
its uncertainty and observed replacement, without retaining continuation or
consent. A parked pending continuation remains available for a later request
to continue. These source corrections are mandatory before this new route is
landed; the older foundation PR remains draft.

The new read-only active-consent check recognizes only the exact played,
dispatched, possibly-sent phase effect with current proof/terms/lease and
matching immutable payload. It rejects original/parallel/completed effects,
altered payloads, interruption, revocation and expiry. It does not admit a new
effect or replace independent native permission/observation/quota checks.

| Actual checkpoint command | Natural result |
| --- | --- |
| `env ABBY_LEDGER=memory node --test --test-concurrency=1 test/text/class-movement-progress.test.ts test/text/class-movement-receipt.test.ts test/text/class-movement-consent.test.ts test/text/class-movement-sam.test.ts test/cliniko/class-movement-verifier.test.ts test/cliniko/class-move-staging-policy.test.ts test/text/effect-deadline.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts` | 53 passes, zero failures/cancellations/skips; log `be9df097-1792151521983.log`. Pure/memory SAM, actual private verifier fixtures, policy capture, shared booking deadline and registry contracts. |
| `env ABBY_LEDGER=memory node --test --test-concurrency=1 test/cliniko/class-move-host.test.ts test/cliniko/class-pass-move-host.test.ts` | 40 passes, zero failures/cancellations/skips; log `be9df097-1792151560686.log`. Existing actual SAM ordinary/pass synthetic host regressions. |
| `node --test test/contract/product-facts.test.ts` | 1 pass, zero failures/cancellations/skips; log `be9df097-1792151561035.log`. Reviewed current claims and directly cited hashes; no behavioral attestation is inferred from hashing. |

Earlier 39-case and 29-case subsets overlap this checkpoint; do not add them.
All jobs finished naturally and their authoritative waits were consumed.
Manifest 1.231 keeps 419 stable IDs, adds the private-verifier/policy witnesses
to E2E-419 and retains planned full-call evidence. No compiler, browser,
database, live provider or deployment ran for this checkpoint.

Next implementation remains the actual native owner and foreground serving
route, bounded by complete proof/permission/native request ceilings. Attach
the owner to the call lifetime and keep each active segment bounded; correlate
the exact in-flight SAM phase rather than the initial `:write` effect. Issue
fresh same-contract terms from current captured approvals without changing the
original request. Preserve explicit ordinary `notApplicable` association and
private one-use continuation references. Route private renewal and fresh
played confirmation through the serving owner; code/continue cannot send.
Unknown request costs cannot be treated as zero or inferred from the existing
proof request floor. Independent operator resolution, mixed catalogue/pass/
correction journeys, process loss, database/backup privacy, full typecheck and
exact-head cloud qualification remain open. Stage 7 and all thirteen gaps
remain active.


## Native staged caller routing: unpublished implementation checkpoint

Above local `e47e32c`, the native class movement host now keeps one private
staged execution and verifier for the call lifetime, with each advance still
using its own bounded native allocation and effect signal. The initial
`:write` guard authorizes only the replacement stage. Later phases validate
their actual consent-derived in-flight effect, played presentation, immutable
mutation, current owner reference/version/ordinal, current approval and native
permission. Ordinary `undefined` native case association is normalized only
to public `notApplicable`; pass association remains a separate stage. Only
joint inspected completion produces a moved receipt. Waiting rotates the
one-use continuation and does not replay an earlier send.

The native host issues fresh same-contract terms after re-reading the captured
source/destination/movement policies. The version, wording and movement targets
remain identical to the original immutable action; its original expiry is not
edited. The current live lease, proof, fresh policy expiry and two-minute
maximum bound the next confirmation, and replacement remains bound to its
original offer deadline. A changed quote or captured source is refused.

The private verifier now renews when the remaining proof cannot cover the
native boundary's required two-minute margin, as well as after expiry. It
retires the old owner and requires the original same-subject private-code
succession. Preparing a live protected readback checks the current verifier's
actual subject proof, including contact and patient permission. Non-disclosing
ownership metadata is confined to private routing guards. The earlier
metadata-only preparation was insufficient: two host tests reproduced a fresh
protected readback after contact or patient permission was withdrawn, log
`be9df097-1792154842009.log`. Restoring the actual proof check retires the
continuation and produces only a fixed review notice on refusal. The combined
proof/readback and verifier contracts then passed 31 cases, log
`be9df097-1792154864099.log`; the subsequent cost-drift, host, call-flow and voice
contracts passed 28 cases, log `be9df097-1792155014467.log`. These scopes overlap
and do not replace full qualification. Protected native boundaries also check
the current actual proof independently. Readback proof requests consume the
shared account budget before a later phase allocation; complete admission must
account for that real remaining capacity. Unknown callback costs remain
unknown; a request floor or physical cap is not a complete phase ceiling.

A shared `ClassMovementTurns` gateway and core reducer accept the caller's
continuation request once, check the current call/session/lease/policy/write
stop and revision, and prepare the exact target/terms/stage readback. The
private owner selects the stage; the model receives no stage-selection or
resume capability. Near-expiry renewal routes through private code entry;
code success prepares no send. Only a subsequent exact affirmative turn after
actual playback admits a distinct phase effect. The admitted call flow and
VoiceSession now delegate that effect to the existing owner. Closing the
owner retires its proof/native lifetime; serialized references cannot rebuild it.

The first actual host check failed after a real replacement because the
synthetic fixture lacked the required provider-owned review GET response,
log `be9df097-1792152602638.log`. Supplying the exact row/self link/update
version, without weakening the reader, passed seven host/verifier checks in
`be9df097-1792152648993.log`. The expanded 59-case run passed 57 and failed two
new test calls to nonexistent `speechBegan`; the existing runtime method is
`beginSpeech`. Correcting those fixture calls then passed all 14 staged host
cases in `be9df097-1792152760957.log`. The 40 existing ordinary/pass host cases
passed in the earlier 59-case run; this is not a clean 59-case aggregate claim.

Further scoped evidence:

| Command / scope | Actual result |
| --- | --- |
| `env ABBY_LEDGER=memory node --test --test-concurrency=1 test/cliniko/class-move-staged-call-flow.test.ts test/text/class-movement-sam.test.ts test/text/class-movement-consent.test.ts` | 25 passed,zero failed/canceled/skipped; log `be9df097-1792153020903.log`. Actual admitted ordinary/pass routing, same-subject renewal, unplayed refusal and core contracts. |
| `env ABBY_LEDGER=memory node --test --test-concurrency=1 test/voice/class-move-staged-session.test.ts` | 1 passed,zero failed/canceled/skipped; log `be9df097-1792153155379.log`. Actual source VoiceSession activation, maintained lease, queued/played readback and later affirmative phase dispatch. This is not a signed-carrier/full listener test. |
| `env ABBY_LEDGER=memory node --test --test-concurrency=1 test/text/class-movement-turns.test.ts test/voice/class-move-staged-session.test.ts test/cliniko/class-move-call-flow.test.ts test/cliniko/class-move-session.test.ts` | 42 passed,zero failed/canceled/skipped; log `be9df097-1792153206859.log`. Included six initial gateway boundaries, actual voice and existing admitted class/session regression. |

The final combined light checkpoint, after invalid/backwards-clock gateway
coverage and explicit optional-field type corrections, passed **79** tests,
zero failures/cancellations/skips, natural exit0 in 26 seconds, tracked log
`be9df097-1792153359854.log`:

```sh
env ABBY_LEDGER=memory node --test --test-concurrency=1 \
  test/text/class-movement-progress.test.ts \
  test/text/class-movement-receipt.test.ts \
  test/text/class-movement-consent.test.ts \
  test/text/class-movement-sam.test.ts \
  test/text/class-movement-turns.test.ts \
  test/cliniko/class-movement-verifier.test.ts \
  test/cliniko/class-move-staging-policy.test.ts \
  test/cliniko/class-move-staged-host.test.ts \
  test/cliniko/class-move-staged-call-flow.test.ts \
  test/voice/class-move-staged-session.test.ts \
  test/text/effect-deadline.test.ts \
  test/contract/scenario-manifest.test.ts \
  test/contract/no-number-gap-trace.test.ts \
  test/contract/product-facts.test.ts
```

Eight gateway boundaries retain state after late/stale preparation; physical
native claims stayed within 180 in the synthetic host journeys. Manifest 1.232
keeps 419 stable IDs and full-call evidence planned. The product facts were
reviewed against changed source, with all directly cited fingerprints refreshed.
Earlier scoped runs overlap this checkpoint and are not added to 79.

This follow-on is unpublished and has not passed a full typecheck. Complete
transitive request-cost ceilings/admission, independent operator resolution,
mixed/catalogue/correction/concurrent cohorts, process-loss and PostgreSQL/
backup/output privacy, rebuilt signed serving, whole-suite and exact-head cloud
qualification remain open. In particular arbitrary proof/lookup/permission
native I/O is not bounded by the old request floor. Do not activate this route
or land it as completed gap10 while those dependencies remain unfinished.
Gust e252 retains the next heavy slot after the 12:01:36 UTC release. No new
Abby typecheck, compiler, PostgreSQL job or automatic heavy retry was launched.

### Unpublished request-cost refinement: admission still incomplete

The current source derives phase ceilings from bounded native reader caps and
explicit callback ceilings bound to the exact scope, account credential and
physical budget. Unknown callbacks, foreign bindings, malformed declarations,
changed captured costs and any required phase above 180 are refused. A request
floor never supplies an upper bound. Declarations describe trusted callback
contracts; actual requests still require the shared physical budget claim.

The cost, staged contention, admitted flow, verification and ordinary native
contracts passed 79 cases, zero failures/cancellations/skips, log
`be9df097-1792154645897.log`. Two earlier runs failed assertions that assumed a
fixed 180-request reservation. The corrected tests explicitly fill the shared
account budget before testing contention, preserving the no-extra-read/write
assertions, fresh confirmation and original deadlines. The largest synthetic
pass journey measured phase claims of 132, 134 and 178 against independently
calculated ceilings, including full bounded metadata, rosters and case history.

Ordinary paired observations now use one actual proof boundary around the
compound read, with proof checks before and after it. Existing ordinary/pass
native and host contracts passed 98 cases, zero failures/cancellations/skips,
log `be9df097-1792154702634.log`. This run predates the additional readback
withdrawal cases recorded above; its scope overlaps other results.

This is not complete admission for the actual serving cohort. The earlier
combined pass association/final-inspection stage exceeded 180 when the actual
proof ceiling was two requests, causing conservative refusal. The unpublished
refinement now separates association from a freshly confirmed read-only
inspection. Only an accepted association queues that inspection; an ambiguous
response still ends for review. Core completion requires the separate
inspection stage and its joint observations. The pure progress, receipt,
consent and SAM contracts passed 38 cases, zero failures/cancellations/skips,
log `be9df097-1792157117056.log`. The additional explicit read-only prompt and
association-skip assertions subsequently passed with the receipt/SAM scope:
23 cases, zero failures/cancellations/skips, log
`be9df097-1792157215723.log`. These scopes overlap. Native owner, actual cost and
serving/process checks of this split remain pending. Existing live owners
cannot be reconstructed or hot-loaded across source changes; the older
foundation draft alone does not implement this protocol. The real phone lookup
has an existing bound: `PostgresPatientPhoneIndex.find` returns at most ten
candidate IDs, and `ClinikoPhoneLookup.candidates` rechecks each through one
patient GET before rechecking the index generation. An oversized index yields
`tooMany` without native candidate reads. Its account/budget-bound cost
declaration and propagation through caller/task wrappers remain unfinished;
synthetic zero-cost declarations cannot qualify it. The complete actual proof
can therefore cost eleven requests even when other callbacks use no native
requests. Splitting association alone does not admit every phase at that
ceiling; further native admission work is required without truncating candidate
ambiguity or weakening proof freshness.
Readback proof requests and competing account work must leave enough physical
capacity for each later phase. Unknown policy/permission/contact-revision
costs remain explicit refusals. No full typecheck, process/database rebuild,
serving activation or completed gap10 claim follows from these focused checks.
Source fingerprints and scenario evidence need review after this refinement
is complete; the earlier fingerprint checkpoint does not cover this delta.


### Four-phase cost refinement and concrete lookup checkpoint (unpublished)

Accepted pass association now queues a separately confirmed read-only joint
inspection. No further attendance mutation occurs in that fourth phase; an
ambiguous association stops for review without queuing it. Completion requires
the inspection's original/replacement/case observations. Native upper costs
include bounded metadata/roster/case readers plus every declared callback for
the exact scope/account/physical budget. Unknown costs, changed declarations
and any required phase above180 still refuse staging.

The actual phone lookup now captures its complete existing index candidate
count, up to ten, without filtering ambiguous candidates. Every invocation
rechecks the current full index; growth refuses before native requests, and
generation drift and aborts remain failures. Task/history/renewal forwarders
preserve known ceilings and cancellation. The concrete SQL-only contact
revision adapter supplies a zero-native-request declaration; arbitrary revision
ports remain unknown. The actual composed proof costs N+1 native reads when
other declared callbacks are local. High-cost cohorts can still exceed a
phase's180 ceiling and are not yet admitted.

Exact focused commands and results (all with ABBY_LEDGER=memory):

- `node --test --test-concurrency=1 test/cliniko/phone-lookup-request-cost.test.ts test/cliniko/verification-request-cost.test.ts`:13 passed, log `be9df097-1792158907173.log`. The real query/transaction adapter runs over DummyDriver; this is not PostgreSQL evidence.
- `node --test --test-concurrency=1 test/cliniko/class-move-stages.test.ts test/cliniko/class-move-verification-renewal.test.ts`:24 stage cases passed, two renewal fixture failures, log `be9df097-1792159076140.log`. Maximum-shape measured phase claims132/134/93/91 (proof1) and139/142/99/97 (proof2) remained below independently calculated ceilings.
- `node --test --test-concurrency=1 test/cliniko/class-move-verification-renewal.test.ts`:first correction produced1 pass/1 failure, log `be9df097-1792159151139.log`; final corrected fixture2 passed, log `be9df097-1792159242159.log`. The first failure assumed a fixed180 reservation; the fixture now fills actual remaining account capacity before asserting quota waiting. The next failure correctly required fresh proof after the last wait left117 seconds; a third real code now supplies a distinct current proof before final inspection. No expiry/deadline/concurrency/assertion was weakened.
- `node --test --test-concurrency=1 test/cliniko/class-move-staged-host.test.ts test/cliniko/class-move-staged-call-flow.test.ts test/voice/class-move-staged-session.test.ts test/cliniko/class-move-request-cost.test.ts`:29 passed, log `be9df097-1792159173737.log`. This exercises actual native host, admitted caller, playback/affirmation and fourth-phase zero writes.
- `node --test --test-concurrency=1 test/cliniko/class-attendance-move.test.ts test/cliniko/class-move-host.test.ts test/cliniko/class-pass-movement.test.ts test/cliniko/class-pass-move-host.test.ts test/cliniko/call-task-sequence.test.ts test/cliniko/request-cost.test.ts`:135 passed, log `be9df097-1792159655213.log`. Existing ordinary/pass behavior and callback forwarding remain covered after the split.

All passing scopes have zero failures/cancellations/skips and overlap earlier
checkpoints; their counts are not added into a whole-suite total. The four-phase
PostgreSQL worker is updated to add explicit competing account claims between
phases and expect three real rolling resets; it has NOT run. Its existing
210-second deadline,180-request cap and three-mutation expectation are unchanged.
Earlier three-phase process/backup evidence cannot qualify the new protocol.

Manifest1.233 retains419 IDs and planned full-call evidence, registers the
focused concrete cost witnesses and distinguishes historical PostgreSQL results.
Product facts were reviewed against this changed source; direct source hashes
are refreshed as a content-drift aid, not a behavioral attestation. Full native
typecheck, high-cost cohort admission, rebuilt signed serving, independent
operator recovery, mixed/concurrent/process/PostgreSQL/backup/output privacy and
whole-suite/cloud qualification remain open. Booking-menu PR466 remains a
separate branch and is not silently included here. All13 gaps and the selected
Stripe provider remain in scope. No production/clinic activation occurred.

The earlier4,500,000KiB host-free-memory floor had no measured derivation and
was a conservative runner choice. The separate menu source5a6 typecheck passed
in65.26s with measured scope peak1,421,070,336 bytes (1.323GiB) and no OOM;
its scope and heap were not explicitly capped. This is a useful observation,
not a guarantee for this larger native tree. No new heavy job is automatically
authorized by Gust's latest release; the next frozen standalone native typecheck
requires a fresh board/source/live-process check and peer coordination.


### Full native typecheck diagnostic and narrow corrections

Frozen697fdbe4b63629d36bcba18db8005813160dba86 ran its first complete
`npm run typecheck` under the explicitly coordinated single slot. Work
1792159844988 naturally exited2 after73.59s at14:11:58.874204UTC; log
`be9df097-1792159844988.log`. All1162 source/dependency/config inputs remained
unchanged. Scope peak was1,574,649,856 bytes (1.467GiB), with no high/max/OOM
events and no explicit scope/heap cap. No free-RAM floor was inferred from that
measurement. Wrapper/Python/npm absence was verified14:12:18.313984UTC and
the slot released to Gust; no automatic retry followed.

The eight diagnostics were a missing session-lease narrowing, widened `none`
lookup literal through the generic cost forwarder, two rejected phase receipts
missing their required reason, a recursive fixture inference needing an explicit
number, an un-narrowed presentation, a union-method spread in the cost fixture,
and a fixture unavailable-action missing its action kind. Corrections preserve
all runtime authority guards and add explicit forbidden rejection reasons. The
withdrawal fixture now requires an actual notice/speech presentation before
asserting that protected target text is absent. No test was removed or skipped.
The corrected source still requires its own complete typecheck.

The corrected `ABBY_LEDGER=memory node --test --test-concurrency=1
test/text/class-movement-turns.test.ts test/text/class-movement-sam.test.ts
test/cliniko/class-move-staged-host.test.ts
test/cliniko/verification-request-cost.test.ts
test/cliniko/class-move-staged-call-flow.test.ts` passed43 cases, zero failures/
cancellations/skips, log `be9df097-1792159977225.log`. Facts were reviewed
against the narrow type changes and directly cited fingerprints refreshed.


### Corrected full TypeScript and four-phase PostgreSQL results

Frozen746227e641f0f2ddc655ca4b3c3ded896ae8f837 passed `npm run typecheck`
in77.84s, work1792160079246/log `be9df097-1792160079246.log`, exit0 at
14:15:57.443130UTC. All1162 input hashes remained unchanged. Scope peak
1,427,951,616 bytes (1.330GiB), all high/max/OOM events0, no explicit heap/
scope limit change. Actual PID absence was checked14:16:07.810009UTC and
the heavy slot released before any further heavy request.

The separately coordinated `bash scripts/with-postgres.sh env
ABBY_LEDGER=postgres node --test --test-concurrency=1
test/cliniko/class-move-stages-process.test.ts` passed both cases with zero
failures/cancellations/skips, work1792160239383/log
`be9df097-1792160239383.log`, exit0 at14:20:35.638228UTC. The first case
completed four phases over three real rolling quota resets with the unchanged
180 cap,210-second deadline and exactly three mutations. The second killed its
own sender and discovered the native review from a fresh process without any
mutation. Database canary scans passed. Total job196.04s, test runtime191.55s.
Own scope peak183,398,400 bytes excludes the Docker PostgreSQL server; no
scope OOM/high/max events occurred. All1162 source inputs stayed unchanged.
Natural terminal and PID absence were reported with a14:20:45UTC release
cutoff; no additional heavy job was automatically launched. This is focused
process/database evidence, not whole-suite, rebuilt signed serving, disposable
backup, operator or real-provider acceptance.

### Large staged caller menu: legacy whole-window rejection corrected

Source review found two remaining legacy total-move filters in the pass offer
and final proposal observations. They hid a valid separately approved large
staged offer even when all complete phase ceilings fit180. The unchanged
light reproduction failed at85 claims with no eligible offer, log
`be9df097-1792160453328.log`. A registered E2E-419 comparison reproduced one
legacy pass and one staged failure, log `be9df097-1792160507949.log`.

The private host now requires current complete pass phase ceilings at both
checks whenever staging is independently approved. It still requires complete
current native observations and unchanged entitlement; legacy execution keeps
its existing whole-move request gate. The first corrected comparison admitted
the proposal but failed a newly added fixture's capitalized `Option one` regex;
actual wording is `option one`, log `be9df097-1792160527788.log`. The fixture
now asserts the actual wording. A larger complete cross-service/case host
journey with999 history and201 roster records was added to the existing
played-consent journey matrix.

`ABBY_LEDGER=memory node --test --test-concurrency=1
test/cliniko/class-move-request-cost.test.ts
test/cliniko/class-move-staged-host.test.ts` passed29 cases with zero
failures/cancellations/skips, log `be9df097-1792160568045.log`. Both legacy
refusal and staged proposal are asserted; the large staged host completes
all four fresh confirmed phases within180 claims per window. No native
replay, expiry, quota or authority assertion was removed. Manifest1.234
retains419 IDs/full-call planned; product claims and cited hashes were reviewed
for this narrow correction. The full typecheck/PG results above qualify746,
not a full new-source run. The later host-only delta still needs full TypeScript.
The PG worker/native execution changed by neither menu correction nor fixture
addition retains its focused earlier evidence; no full PG rerun is inferred.

The host-only delta also passed40 existing ordinary/pass host cases under
`ABBY_LEDGER=memory node --test --test-concurrency=1
test/cliniko/class-move-host.test.ts test/cliniko/class-pass-move-host.test.ts`,
log `be9df097-1792160680932.log`, zero failures/cancellations/skips. The
updated manifest/facts scope passed both contracts, log
`be9df097-1792160668488.log`. No broader run is inferred from these scopes.


### Frozen93b final native caller source typecheck

The separately coordinated standalone `npm run typecheck` passed on
93b51cf791fa537f5717da453b0eb8641688eea7, work1792160778784/log
`be9df097-1792160778784.log`, natural exit0 at14:27:27.186872UTC after
68.18s. All1162 TS/dependency/config hashes remained unchanged. Measured
scope peak1,596,239,872 bytes (1.487GiB), all high/max/OOM counters0, no
explicit heap/scope cap change. PIDs were absent at14:27:47.183894UTC;
release cutoff14:27:48UTC was reported to Gust. No further heavy job followed.
This qualifies the final host menu delta for TypeScript, in addition to its
29 focused host/cost and40 legacy-host cases. Earlier746 two-case focused
PostgreSQL evidence covers unchanged native execution and worker code; no
new full serving/database/backup or whole-suite run is claimed.

The follow-on remains draft work above PR465. Independent operator resolution,
high-cost/mixed/concurrent cohorts, rebuilt signed serving, disposable backup/
output privacy and authoritative cloud acceptance remain open. All13 gaps stay
active; Stripe remains selected for gap11. No deployment, provider access or
clinic activation occurred.


### Published native caller draft and exact cloud startup result

Draft PR467 publishes1d3668a9e20e84d7b560c0f46cf434da77d6f470 above
PR465: https://github.com/garthtrickett/abby/pull/467. Exact-head push
run38916126275 and PR run38916136059 both completed failure, all eight
jobs zero steps. Check117023977419 explicitly reports failed account payments
or a spending limit. No cloud code ran, no retry/configuration change/ready
transition/merge followed; the exact evidence is also on the draft. Billing
does not prevent the independent gap10 source work below.

### Cold staff movement recovery: unpublished memory checkpoint

A separate worktree/branch above native caller PR467 adds cold staff resolution
without reconstructing a caller owner, proof or confirmation. A current clinic
administrator and directory membership, independently investigated/quiescent
authority, exact captured policy/terms/staging and fresh joint native records
are required. An acknowledged review can yield distinct reviewed-moved or
reviewed-restored observations; the ended caller action is unchanged. The
reader makes only native GETs, never replays a mutation or persists a local
patient-linked resolution. Missing replacement evidence cannot establish
restoration from an empty active roster. Current policies/upcoming occurrences
bound this initial route; expired/different contracts and past occurrences
stay for manual Cliniko investigation. ADR0003 records this domain distinction.

The exact policy/terms digest and text generation is shared with the live
host through one contract helper, preserving the existing serialized version
and wording. Native reader/writer inspection and pass evidence are reused;
no weaker alternate native parser is added. A final joint class re-observation
rejects changed attendance after the exact record inspections. The private
staff read scope is freshly authenticated, expires/aborts independently, is
never returned or serialized and grants no caller or provider-write authority.

The optional authenticated dashboard hook exposes POST
`/api/class-movements/review` only when explicitly provisioned by the owning
host. Same-origin/admin checks, actor re-read after factory creation, exact
citation-only input and fixed output redaction precede the response. Setup-only
and unprovisioned surfaces return404. No new public setting activates it.

Validation (`ABBY_LEDGER=memory`, no real provider/database):

- Initial `node --test --test-concurrency=1 test/cliniko/class-move-recovery.test.ts`:9 pass/3 fail, log `be9df097-1792161513013.log`. Ordinary recovery correctly refused incomplete synthetic native responses: the fixture omitted arrived and implemented the is-null case predicate only for passes. The fixture now supplies native arrived=null on created attendance and enforces exact ID/patient/booking/is-null predicates for ordinary and pass reads. No runtime check was weakened.
- The corrected12-case scope passed, log `be9df097-1792161583001.log`; extended drift/cross-case scope24 passed, log `be9df097-1792161649475.log`. These overlap.
- Focused authenticated HTTP test passed1 case, log `be9df097-1792161794847.log`; it uses a temporary synthetic bundle to exercise the real listener/route, not a compiled browser acceptance claim.
- `node --test --test-concurrency=1 test/cliniko/class-move-recovery.test.ts test/cliniko/class-move-staged-host.test.ts test/cliniko/class-move-host.test.ts test/cliniko/class-pass-move-host.test.ts test/text/dashboard-listener-origin.test.ts`:89 passed, zero failures/cancellations/skips, log `be9df097-1792161892368.log`,71.58s. This includes ended caller, ordinary/pass/cross-case moved observation, exact cited restoration, partial/acknowledgement uncertainty, permission/directory/policy/review/roster/entitlement/time/abort drift, final joint re-observation and actual HTTP authorization/privacy, plus existing movement/listener regressions. Counts are not added into a whole-suite result.

Manifest1.235 keeps419 stable IDs/full-call planned and registers this E2E-419
operator witness. Product facts and directly cited fingerprints were reviewed
against the new source. This tree still requires full TypeScript; current
operator process/database/backup/output privacy, rebuilt signed serving, broad
cohorts and real clinic/operator/cloud acceptance remain open. Gap10 and all13
gaps remain active. No heavy job was launched for this source.

Two additional lost-reply contracts passed after the89-case checkpoint:
`ABBY_LEDGER=memory node --test --test-concurrency=1
--test-name-pattern="uncertain.*caller action"
test/cliniko/class-move-recovery.test.ts`, log
`be9df097-1792162144628.log`,2 passed, zero failures/cancellations/skips.
The synthetic provider applies original cancellation/association before losing
the reply. Fresh staff inspection can report current moved state, while the
actual ended caller action remains needsReview byte-for-byte. This specifically
qualifies the distinction between staff assessment and caller completion. The
fixture now accepts the explicit lost-reply mode; unchanged modes retain their
previous behavior. The earlier facts/registry/portability/gap-trace scope passed
all4 contracts, log `be9df097-1792162101415.log`.


### Cold staff process, database and backup qualification

The first operator full TypeScript run at frozen `351543f` failed on three
TS2783 duplicate `scope` spreads, log `be9df097-1792162292035.log`.
It finished naturally at14:52:44.497362UTC in72.24s, peak1,595,772,928B,
OOM/high/max0 and1,165 unchanged source inputs. The correction constructs
explicit native scope/practitioner/type/class-name config rather than spreading
policy records into readers/writer. No authorization or inspection check changed.
The corrected28-case memory recovery file passed, log
`be9df097-1792162395552.log`. After extracting its exact fixture for shared
process use, all28 passed again in33.54s, log
`be9df097-1792162884106.log`. These results overlap earlier memory coverage.

New command:
`bash scripts/with-postgres.sh env ABBY_LEDGER=postgres node --test
--test-concurrency=1 test/cliniko/class-move-recovery-process.test.ts`.
Tracked work1792162929384 passed2 cases, zero failures/cancellations/skips,
log `be9df097-1792162929384.log`. Actual start15:02:09.628049UTC and
natural terminal15:02:24.142825UTC;1,168 exact source inputs unchanged.
Scope peak217,210,880B excludes the Docker PostgreSQL server; all
OOM/high/max counters0. No follow-on heavy job ran.

A new worker process uses captured owner policies/directory and independently
installed synthetic staff/financial ports to inspect provider-held records. Its
input contains native citations and nonpatient configuration, no serialized
caller proof/code/action root/patient identity/stage capability. The parent
retains synthetic Cliniko state only. Cases observe moved state after an applied
pass association loses its reply, and exact cancelled replacement restoration.
The worker sends GETs only; original ended caller state and provider write count
remain unchanged. Fresh real PostgreSQL native claims are positive and at most180,
reservations empty; nine private canaries are absent from database, disposable
pg_dump backup, worker input and fixed public output. Synthetic host permission
is explicit; this is no real authentication/investigation or clinic acceptance.

Manifest1.236 keeps419 stable IDs and full-call planned. Product claims and
cited fingerprints were reviewed. Corrected-source full TypeScript, rebuilt
signed serving, broader mixed/concurrent/high-cost cohorts, independent review,
real clinic/operator and authoritative cloud acceptance remain open. PR467's
billing startup failures remain unresolved externally. Gap10/all13 stay active.


The full check at `2dcdcf4` emitted no runtime-source diagnostics, but the
command still failed two TS2339 diagnostics in the new process test's
canary setup: its generic ActionRequest had not been narrowed to reschedule.
Tracked work1792163371729, log `be9df097-1792163371729.log`, naturally
finished15:10:48.092618UTC exit2 after76.16s;1,168 inputs unchanged,
peak1,594,728,448B, OOM/high/max0. An explicit assertion that the synthetic
caller request is a reschedule now narrows its patient fields. No runtime or
provider logic changes; the preceding PostgreSQL results cover the same worker
and recovery graph before this test assertion. Another full check is pending;
no automatic heavy retry followed the failure.


### Cold staff recovery final source typecheck

Frozen `671c4748b2cd68e56366676199d020c68658f7b6` passes
`npm run typecheck`, tracked work1792163735709, log
`be9df097-1792163735709.log`. Actual start15:15:36.081693UTC,
natural terminal15:16:57.497249UTC,81.42s, exit0. All1,168 TypeScript/
package/config inputs unchanged; whole scope peak1,570,353,152B (1.463GiB),
OOM/high/max0. Wrapper1319478 absence verified; heavy slot released without
another launch. The only source delta since the passing two-case PostgreSQL
run is a test-only action-kind assertion/narrowing and registry test version;
worker and runtime graph are unchanged. No new-source PostgreSQL rerun is
claimed. Final facts and registry qualification are recorded separately.

This completes the narrow cold staff reader/optional authenticated route source
checkpoint for draft review. Rebuilt signed serving, complete mixed/concurrent/
high-cost cohorts, independent review, real clinic/operator and authoritative
cloud acceptance remain open. Gap10 and the full13-gap order remain active;
Stripe11 follows the remaining class prerequisites rather than replacing them.

Final facts/registry contract command `node --test --test-concurrency=1 test/contract/product-facts.test.ts test/contract/scenario-manifest.test.ts` passed2 cases, log `be9df097-1792163867002.log`. These are documentation/registry guards, not another runtime or whole-suite result.


### Published cold staff recovery draft and cloud startup blocker

Draft [PR468](https://github.com/garthtrickett/abby/pull/468) publishes
`82eeace94222b19c19930472b7ee9cbfe663fb41` above native-caller PR467.
Publish work1792163895144 finished naturally exit0. Exact-head Actions push
run38922830667 and PR run38922838611 each failed four jobs with zero steps.
PR check117046834594 explicitly reports account failed payments/spending limit;
no cloud runtime/typecheck/browser/PostgreSQL verdict exists. Draft body records
the exact blocker via work1792163983419; no ready/merge/retry loop follows.

A separate unpublished follow-on worktree prepares two compiled signed voice
cases for ordinary and maximum-history cross-case pass staging. It uses actual
phone-index lookup/contact revision and PostgreSQL budget, binds only audited
synthetic in-memory callbacks' costs to that physical account, ages proof across
real elapsed quota windows, and requires distinct played phase readbacks plus
private renewal. Allowed phone-to-ID storage is checked exactly; clinical/code/
grant/review data remain forbidden everywhere and in backup/public output.
These new fixtures have syntax-only inspection so far: no compiled, runtime,
whole-suite or acceptance pass is claimed. Build and execution require separate
fresh heavy coordination. All13 gaps remain active.


Frozen serving fixture source `b84d7aff` passes `npm run build:voice-tests`,
work1792164064183, log `be9df097-1792164064183.log`. Actual
start15:21:04.437376UTC and natural terminal15:21:40.753542UTC,
exit0/36.32s,1,169 inputs unchanged, scope peak833,572,864B (0.776GiB),
OOM/high/max0. All448 emitted JavaScript files are pinned for later execution.
This build checks its serving/fixture dependency graph, not the unimported new
TypeScript test or full repository. A copied runner banner says standalone
native typecheck; the actual command is explicitly `build:voice-tests` and no
standalone full typecheck/test/PostgreSQL command was bundled.

Before the first semantic run, the new journey was refined to wait one actual
quota window before initial affirmation as well as between phases, because
preparation consumes real shared requests. The original120-second offer still
bounds initial dispatch. Heartbeats age the synthetic proof exactly61 seconds
per real elapsed window without changing limits/stored timestamps. New case
deadlines are180 seconds for ordinary/two real windows,300 seconds for pass/
four real windows plus private renewal and privacy scans; no existing test's
deadline changes. Only the uncompiled test changes after the build; emitted
serving/fixture graph stays unchanged. Semantic execution remains pending.


### Signed ordinary failure exposes the phase-wait serving boundary

ONE ordinary case on `08f18ef`/448 pinned compiled files ran via
`bash scripts/with-postgres.sh env ABBY_LEDGER=postgres node --test
--test-concurrency=1 --test-name-pattern="compiled signed ordinary"
test/voice/class-move-staged-runner.test.ts`, work1792164241199,
log `be9df097-1792164241199.log`. It failed1 case, zero skips/cancellations,
naturally terminal15:25:34.595489UTC after93.11s, scope peak203,845,632B
excluding Docker PostgreSQL, OOM/high/max0, source/artifact pins unchanged.
Initial affirmation after the artificial61-second silence produced no response
within the unchanged20-second response bound. Heavy slot was released; no
unchanged retry or pass case followed.

Static tracing found the fixture exceeded the existing15-second listening/
playback protocol. Initial quota waiting already has a bounded caller-facing
confirmation-wait notice; the fixture now follows that actual flow rather than
sleeping unannounced before yes. Later phases lacked equivalent preparation
wait metadata: a full account could consume/retire proof while attempting the
next read, and a silent wait could not preserve the transport. The new memory
reproduction failed at the missing notice, log
`be9df097-1792164585419.log`. A narrow correction returns a1–60-second
quotaWait preparation before protected proof work; the core preserves pending
state and emits fixed listening metadata, with no consent/reservation/send.
The native preflight includes the complete phase plus one full proof and the
existing two ownership/permit-pair bound for preparation. Unknown capacity or
total above180 refuses. The actual phase still reserves and every request
still claims; concurrent theft remains a safe refusal. Cancellation aborts
headroom observation and current state/costs are rechecked before any notice.

The first corrected memory contract passed1 case, log
`be9df097-1792164624946.log`. The bounds/gateway/renewal/voice scope
`ABBY_LEDGER=memory node --test --test-concurrency=1
test/cliniko/class-move-phase-wait.test.ts test/text/class-movement-turns.test.ts
test/cliniko/class-move-staged-call-flow.test.ts
test/voice/class-move-staged-session.test.ts` passed15 cases in19.65s,
log `be9df097-1792164686100.log`. These overlap the first case. A later
abort-aware headroom await still needs its final focused rerun. Manifest1.237
retains419 IDs/full-call planned; the compiled test remains unregistered as
passing. Rebuild, signed ordinary/pass execution, full new-source TypeScript,
independent/real operator/cloud acceptance and all13 gaps stay open.


The staged native host/cost/cold recovery regression command
`ABBY_LEDGER=memory node --test --test-concurrency=1
test/cliniko/class-move-staged-host.test.ts
 test/cliniko/class-move-request-cost.test.ts
 test/cliniko/class-move-recovery.test.ts` passed57 cases, log
`be9df097-1792164747034.log`,49.56s. The abort-aware await was added
while this light matrix was in flight, so this is not claimed as an exact-frozen
whole-matrix result for that last edit. The final phase-wait file, including
actual held-headroom cancellation, passed5 cases after that edit, log
`be9df097-1792164831617.log`: cancellation resolves without waiting for the
budget callback, late release cannot change state, and a fresh request can still
prepare from the private owner. The assertion/deadline/physical limit remains
unchanged. The corrected signed fixture now follows the existing initial
confirmation wait and new explicit phase preparation waits; it does not sleep
unannounced or alter the transport's silence deadline. New rebuilt graph and
signed ordinary/pass runtime qualification remain pending.


### Corrected build, ordinary continuation failure and clock investigation

Frozen `3ada20a` passes `npm run build:voice-tests`, tracked
work1792164945727/log `be9df097-1792164945727.log`, natural exit0
at15:36:21.448263UTC,35.44s, peak830,599,168B/OOMhighmax0,
1,170 source inputs unchanged and448 compiled JavaScript files pinned.
No PostgreSQL or full typecheck was bundled.

The one corrected ordinary case then ran under the same source/artifact pins,
work1792165071076/log `be9df097-1792165071076.log`. It reached one
replacement write and the partial-movement notice, then failed on the first
"Continue my class move" response timeout. Natural terminal15:39:25.617850UTC,
exit1/94.32s, scope peak192,856,064B excluding Docker PostgreSQL,
OOM/high/max0. No pass case or unchanged retry ran; Gust799 then a989 took
heavy priority. Current signed ordinary/pass qualification remains absent.

Static diagnosis: MediaTurnController stamps the completed turn from wire
capturedAt, while this fixture sends840ms speech bursts without advancing its
synthetic host clock. After the real initial wait its media timeline can remain
ahead of that clock. ClassMovementTurns intentionally refuses startedAt earlier
than turn.at; memory gateway cases already preserve this guard. This is a
specific clock-mismatch hypothesis, not a measured verdict from that failed run.
The fixture now aligns its synthetic clock forward to the next media-turn end,
with a15-second per-step guard, and emits a fixed aheadByMs observation for the
actual continuation. Production clock/lease/deadline checks are unchanged.
On response failure a new synthetic-only diagnostic projects fixed lifecycle,
lease interval, action/effect/presentation statuses and phase enums before and
after the turn. It excludes identifiers, text, proofs, codes, recipients and
native citations. This is test instrumentation, not a product endpoint.
Syntax inspection passes; rebuild/semantic measurement and full TypeScript
remain pending. No source-only inference is promoted to a passing journey.

Remaining cost-admission edge: the new preparation check includes phase plus
preparation overhead, but menu admission currently validates native phases
alone. Near-limit callback cohorts can still be offered and then refused by
the stricter combined preparation bound. This is safe refusal, not complete
serving admission. Centralize/test the host's combined admission before closing
that requirement; retain the native-only coordinator's separate ceilings.
