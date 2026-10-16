# Execution progress and evidence

**Updated:** 16 October 2026. **Objective:** Work through [EXECUTION_ORDER.md](EXECUTION_ORDER.md), preserving its full thirteen-gap scope. This ledger records partial delivery; the integration is not complete or activated.

## Current position

| Execution stage | Current evidence and next action |
| --- | --- |
| 1 Aeva preservation | Independently retrieved and hash-checked 113 explicit source/test/map references at the audited revision through GitHub. All four original planning documents were published and independently retrieved at Abby `229a3596696d8ebb9bf263e58457f412898c1327`. Local-only material still requires owner selection and preservation before deletion. |
| 2 Delivery baseline | Remote main verified at `9a29e51e7f7e0a765db7674c6c75ff2087260473`; integrated draft [PR #457](https://github.com/garthtrickett/abby/pull/457) remains at `4e19e1783e2324480c9e0d0923eeaf825e04692e`. Its GitHub jobs never started because of account billing/spending limits. Focused local qualification of the receipt candidate is recorded below; whole-candidate CI remains outstanding. |
| 3 Exact receipt foundation | Implemented and locally qualified in `codex/abby-provider-ack-receipt`, stacked on the published plans and integrated candidate. The full interval is captured, sent and validated. Existing post-write host success gates remain. Independent review and exact-head CI remain outstanding. |
| 4 Individual booking | Next implementation: finish preparation before final online/roster availability and preserve validated acknowledgement through the host, reviewed-send wrapper and effect worker. |
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

## Review, acceptance and remaining limits

Author review compared the receipt delta with booking step 1: exact interval evidence is added without changing final-availability ordering, native class logic, host post-write gates or shared cancellation/rescheduling/correction/resend semantics. An incomplete/mismatched creation acknowledgement now remains uncertain even if a later GET could supply the missing interval; this is the receipt requirement in the owner's instruction to execute the booking plan. No new caller wording, clinic setting or notification is introduced. The owning-diary proof remains separately executed rather than inferred from the earlier embedded test host. Independent review of the exact published candidate remains outstanding.

No live clinic test is needed to claim this narrow synthetic receipt foundation. Before the later booking policy is activated, propose separately authorized ordinary/class success and interrupted-review discovery tests using owned provider fixtures; check audible result, independent native state and cleanup separately. A manual diary read is acceptance evidence and must not become a runtime success gate again. The clinic must accept the remaining external races and recovery workflow.

GitHub's exact PR #457 job `116295932632` reported no steps and the annotation: “The job was not started because recent account payments have failed or your spending limit needs to be increased.” No code failure was established by that job. Only the account owner can resolve that condition; no billing, workflow, test threshold or repository policy was changed to bypass it. Local engineering can continue, but required cloud qualification and landing remain open.
