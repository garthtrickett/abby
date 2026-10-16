# Execution progress and evidence

**Updated:** 16 October 2026. **Objective:** Work through [EXECUTION_ORDER.md](EXECUTION_ORDER.md), preserving its full thirteen-gap scope. This ledger records partial delivery; the integration is not complete or activated.

## Current position

| Execution stage | Current evidence and next action |
| --- | --- |
| 1 Aeva preservation | Independently retrieved and hash-checked 113 explicit source/test/map references at the audited revision through GitHub. All four original planning documents were published and independently retrieved at Abby `229a3596696d8ebb9bf263e58457f412898c1327`. Local-only material still requires owner selection and preservation before deletion. |
| 2 Delivery baseline | Remote main verified at `9a29e51e7f7e0a765db7674c6c75ff2087260473`; integrated draft [PR #457](https://github.com/garthtrickett/abby/pull/457) remains at `4e19e1783e2324480c9e0d0923eeaf825e04692e`. Its GitHub jobs never started because of account billing/spending limits. Focused local qualification of the receipt candidate is recorded below; whole-candidate CI remains outstanding. |
| 3 Exact receipt foundation | Implemented and locally qualified in `codex/abby-provider-ack-receipt`, stacked on the published plans and integrated candidate. The full interval is captured, sent and validated. Existing post-write host success gates remain. Independent review and exact-head CI remain outstanding. |
| 4 Individual booking | Published in draft [PR #460](https://github.com/garthtrickett/abby/pull/460), `codex/abby-provider-ack-individual`, based on receipt correction `92a16e5`. Final online/roster availability follows preparation; exact acknowledgement survives host/review/worker cancellation. Focused, isolated database/process/compiled-location and complete local `npm test` checks passed. Independent review and cloud qualification remain open; cloud jobs have not started because of billing. |
| 5 Native class creation | Pending stage 4, then exact attendee acknowledgement and final capacity ordering without weakening movement/pass contracts. |
| 6 Earlier-gap qualification | Pending the booking runtime steps. Preserve all gaps 1–9 and their remaining engineering/acceptance requirements. |
| 7 Class/pass completion | Pending; staged caller/SAM/operator integration, complete cost admission and broader combinations remain required. |
| 8 Payments | Pending gap 11 specification and implementation, including audit R18/R19 and any necessary approved receipt attachment dependency. |
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

Runtime commit `86e09b444818356113af626379de5f165817bcf0` is published in draft PR #460 against `92a16e58b559dbd730ad8f0c50c4f23ecbe57bbb`. Its push run `38872610729` and PR run `38872618610` failed before job execution. Check `116880049725` independently reported the same billing/spending condition. Full local qualification continues in the tracked `Abby individual complete local suite` user-systemd scope; observation timeouts have not stopped or restarted that job.

The stage 4 delta is based on receipt PR #459, including its separate fixture correction. `ClinikoBookingGuard.authorizeForSend` and concrete/catalogue offer dispatch paths finish proof, file/catalogue approval, SAM settings, shared write-stop checks and native metadata preparation before final availability. The POST budget is claimed before this path; unavailable quota refuses before sending, without a quota wait after the final observation. Online reads retain complete pagination. Roster dispatch retains its complete double calendar observation and performs no later metadata refresh; ordinary protected proposal/reschedule reads keep their existing refresh contract. Immediately before transport invocation, only synchronous original-expiry, local proof/lifetime and abort checks remain.

The individual host returns committed on the exact validated creation acknowledgement and performs no created-row/conflict GET or automatic review closure. A synchronous trusted acknowledgement notification propagates that established result through the host, reviewed-send wrapper and effect worker. The worker accepts only its matching booking action while its dispatch is still pending; late reports cannot reopen a finished dispatch, reports for other operations are ignored, and normal runtime action/version/lease acceptance still applies. Unparsed/held/lost/nonexact responses remain uncertain. No local durable acknowledgement/attempt record, automatic observer, timer extension, slot reservation or additional setting is introduced.

Catalogue, intake-to-booking and normal call-flow adapters forward the trusted notification. Native class creation, class movement/pass relinking, rescheduling, cancellation, correction, resend and the earlier embedded/owning-diary contracts retain their existing completion semantics. Product notes and ADR 0002 activate only the individual contract in this candidate; the class step remains pending. All thirteen gaps and external acceptance requirements remain in scope. Audit R11 starts with a small [product facts reference](PRODUCT_FACTS.md), kept separate from public FAQs/support advice; its content and 21 cited source/test/ADR files have matching fingerprints, without an automated behavioral or publication attestation.

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

## Review, acceptance and remaining limits

Author review compared the receipt delta with booking step 1: exact interval evidence is added without changing final-availability ordering, native class logic, host post-write gates or shared cancellation/rescheduling/correction/resend semantics. An incomplete/mismatched creation acknowledgement now remains uncertain even if a later GET could supply the missing interval; this is the receipt requirement in the owner's instruction to execute the booking plan. No new caller wording, clinic setting or notification is introduced. The owning-diary proof remains separately executed rather than inferred from the earlier embedded test host. Independent review of the exact published candidate remains outstanding.

No live clinic test is needed to claim this narrow synthetic receipt foundation. Before the later booking policy is activated, propose separately authorized ordinary/class success and interrupted-review discovery tests using owned provider fixtures; check audible result, independent native state and cleanup separately. A manual diary read is acceptance evidence and must not become a runtime success gate again. The clinic must accept the remaining external races and recovery workflow.

GitHub's exact PR #457 job `116295932632` reported no steps and the annotation: “The job was not started because recent account payments have failed or your spending limit needs to be increased.” No code failure was established by that job. Only the account owner can resolve that condition; no billing, workflow, test threshold or repository policy was changed to bypass it. Local engineering can continue, but required cloud qualification and landing remain open.
