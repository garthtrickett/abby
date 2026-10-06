# Conversation baseline

The 45 rewritten candidates in [clinic-conversation-candidates-v1.json](clinic-conversation-candidates-v1.json)
now have executable fixture plans. Each case exercises Abby's actual signed
HTTP/WebSocket call composition, workflow owner, synthetic Cliniko HTTP, private
email OTP, playback receipts and SAM state. Calls run with four independent
workers against one disposable PostgreSQL instance; each owns its scope,
provider, mail, approval files, socket and transient state.

## What this measures

Pinned structured responses establish the required pre-call state. These are
setup fixtures, not evidence of model understanding. In live mode, only the
candidate caller turns use the configured model through the production
structured Responses resolver and its five-second deadline. The model cannot
authorize a provider write. No raw source call, recording or real patient data
is loaded by this evaluator.

Every case checks unchanged provider write count, preservation of prior known
SAM outcomes and exclusion of private canaries from model requests. A separate
conversation observation records the specific selection, clarification or
response being evaluated. All prose requirements and forbidden behaviors are
also retained as **unassessed**: these narrow observations do not prove full
acceptance, audio quality, actual telephony or production activation.

Nine candidate setups require capabilities the current standalone call flow or
baseline fixture cannot supply. The runner exercises a declared substitute
state and reports `setupMatch: false`, an explicit `setupGap`, and a failed
conversation observation. It does not invent staff receipts, public knowledge
approval or additional practitioner/service authorizations.

Scripted mode deliberately returns `unsupported` for candidate turns. It is a
harness and safety check; its results are not a language-quality score.

## Run it

From the repository root, with Docker available:

```sh
npm run eval:conversations -- --scripted baseline --out eval/results/scripted.json
node --env-file=.env scripts/evaluate-clinic-conversations.ts --model gpt-4o-mini --out eval/results/live.json
```

Add `--case CCP-005` for a focused run. Live mode requires the owner-only
`ABBY_OPENAI_API_KEY`; it uses no live Cliniko, email or Twilio credentials.
Each run reserves a new owner-only JSON report and incremental `.jsonl` journal;
existing files are never overwritten. Reports hash the corpus, package metadata,
all TypeScript source, runner and fixture helpers, and recheck source stability
after the run. A nonzero exit can mean observed product gaps, setup gaps,
privacy failure, harness failure or changed source; inspect these separately.

`E2E-307` checks actual played ambiguous offers, a trusted spoken selection without a model request,
an explicitly absent saved staff request, and a lost booking response that stays
uncertain without replay. It does not claim the 45 acceptance scenarios pass.

## Next changes

1. Resolve natural spoken choices against authoritative, latest played offers;
   clarify ambiguous times and near matches.
2. Invalidate proposals on corrections and require a fresh played confirmation.
3. Clarify cancellation versus rescheduling before proposing a destructive action.
4. Route staff requests with accurate available, saved and uncertain states.
5. Add approved catalogue constraints, read-only enquiries and public facts.

Re-run the same corpus after each change. Preserve the pre-change report; do not
change expectations to turn an unsupported fallback into feature completion.

## Recorded pre-change live result

[Source-pinned report](baselines/clinic-conversation-before-v1.json), run with `gpt-4o-mini` on 2026-10-06, before changing the production resolver or workflows.

- 45 candidate turns executed through real model responses; zero harness failures.
- 135 narrowly scoped safety observations passed; database patient-data canary scan passed.
- 12 conversation observations passed; 33 failed, including nine explicitly mismatched setups. This is not a full acceptance score.
- Source remained unchanged throughout the run.

The run exposed guesses for ambiguous morning/evening times and misheard selections, cancellation proposals for requests about moving or questioning a target, missing correction support and generic staff fallback for unrelated requests. The date correction also resolved to the wrong day. Existing exact committed/uncertain outcome queries preserved their receipts without replay. These are observed model/workflow results, not claims about real recorded audio or actual provider writes.

## Spoken selection follow-up

[Source-pinned follow-up report](baselines/clinic-conversation-after-spoken-selection-v1.json), also run on 2026-10-06 with `gpt-4o-mini`, records 45 executed cases, no harness failures and unchanged source. All 135 safety observations and the database canary scan passed. Narrow conversation observations improved from 12 to 15, with no previously passing observation regressing in this run. Thirty observations still fail, including the same nine setup gaps.

CCP-006 (morning/evening ambiguity), CCP-007 (reference to an older menu), and CCP-042 (misheard selection) now clarify without proposing an appointment. CCP-005 resolves its actual 10:30 offer through trusted facts rather than a model ordinal. Three candidate turns bypassed the model through trusted menu interpretation; the remaining 42 made live requests. This mixed workflow score does not measure only model quality, and a single run does not establish statistical reliability.

`E2E-308` adds signed-call evidence for half-past-ten, the later one, rejected offers, ambiguity, a deliberately wrong model choice and interruption of an unplayed menu. Known choices still go through protected offer/proof checks, exact confirmation playback and one possible send. The correction follow-up below covers unsent proposals. Cancellation versus rescheduling, staff handling and broader search remain outstanding.

## Correction follow-up

[Source-pinned correction report](baselines/clinic-conversation-after-corrections-v1.json), run on 2026-10-06 with `gpt-4o-mini`, executed all 45 candidates with zero harness failures and unchanged source. All 135 safety observations and the database canary scan passed. Six candidate turns used trusted interpretation; 39 made live model requests.

CCP-003 now cancels the original 9:00 proposal and prepares the exact revalidated 10:30 replacement without sending. CCP-008 treats the whole mixed yes/no utterance as a correction, cancels the old proposal and clarifies. Narrow conversation observations total 16 passing and 29 failing, including the unchanged nine setup gaps. CCP-031's duration-change observation passed in the prior run but fails here: the response is generic selection clarification rather than the required unsupported-operation explanation. This single live repeat is not a causal or statistical reliability claim.

`E2E-309` separately verifies nine signed-call journeys, including booking and rescheduling time/date replacement, the protected original move source, a held interpretation, a stop request, mixed yes/no, lost availability and interruption of the replacement confirmation. Old proposals are fenced before interpretation. Successful replacements need newly played exact details and a separate later affirmation before the sole clinical send. Host preparations may be replaced only after cancellation; attempted or known sends keep their existing fence.

The bounded date parser accepts a bare weekday or an unambiguous future ISO date. Requests with additional qualifiers such as “Wednesday morning” still clarify, because time-window support is not yet implemented. Corrections after a committed action retain the known receipt and do not undo or replay it, but still need a better caller explanation and separately authorized next workflow. These outstanding conversation failures remain visible in the report.

## Cancellation and rescheduling follow-up

[First change-intent report](baselines/clinic-conversation-after-change-intent-v1.json) and [refined change-intent report](baselines/clinic-conversation-after-change-intent-v2.json), run on 2026-10-06 with `gpt-4o-mini`, each execute all 45 candidates with zero harness failures, unchanged source, all 135 safety observations passing and a clear database canary scan. The first records 20 passing conversation observations; refinement records 21 passing and 24 failing. Nine setup gaps remain. The refined run makes 28 actual model requests; 17 candidate turns use trusted interpretation. Its production behavior is unchanged by a subsequent optional-value type guard in the evaluator.

CCP-001 now clarifies cancellation versus moving. CCP-010 discards a disputed target. CCP-031 and CCP-038 explain unsupported duration/type/patient changes. CCP-036 prepares the specifically requested second protected appointment. CCP-045 restates the recorded booking outcome when the caller wants to change a committed time, without undoing or sending another mutation. CCP-037's unsupported-language observation, previously passing in the corrections report, fails both change-intent runs; generic clarification is not the required language explanation. Scores remain narrow observations rather than full prose acceptance or reliability claims.

`E2E-310` exercises 15 signed-call cases on four isolated workers. It tests both directions of an unsent cancellation/rescheduling switch, new operation-bound verification, independent approval refusal, fresh target listing after disagreement, exact second-target confirmation, an unplayed target list, contradictory instructions, a malicious model cancellation guess, unsupported changes, and committed/uncertain outcome preservation. A switch disposes the former owner and transfers neither proof nor private menus. The unchanged protected source must match across the switch, and the sole provider write follows new exact playback and a separate affirmation. Confirmed or possibly sent actions cannot switch owners or compensate automatically.

The interrupted pre-refinement jobs did not establish success; tracked replacements ran in systemd scopes and produced the cited evidence. Public staff requests, broader approved search, independent appointment enquiries and clinic FAQs remain outstanding. No clinic capability or real carrier traffic was activated by these synthetic tests.

## Staff-request follow-up

[Initial staff report](baselines/clinic-conversation-after-staff-v1.json) and [final explicit-request report](baselines/clinic-conversation-after-staff-v2.json), run on 2026-10-06 with `gpt-4o-mini`, each execute all 45 candidates with zero harness failures and stable source. Both record 22 passing conversation observations and 23 failing, all 135 safety observations passing and a clear database canary scan. The [isolated staff-route report](baselines/clinic-conversation-after-staff-v3.json) repeats the same 22/45 result on the final production source with all safety/privacy checks passing, zero harness failures and stable source. Twenty candidate turns use trusted bounded interpretation, including staff request/status language; 25 make actual model requests. This remains a partial workflow baseline, not full prose acceptance, a release gate or a statistical reliability estimate.

CCP-016 now respects the request for a receptionist and explains the unavailable contact path. CCP-017 uses an independently verified, approved synthetic staff workflow and an actual exact recall acknowledgment before saying the request was saved, without claiming staff read it. CCP-018 starts with an actual response-lost recall send and explains uncertainty without another POST. Their former saved/uncertain setup gaps are removed; seven unrelated setup gaps remain. CCP-023's contact observation also passes. CCP-034, CCP-035 and CCP-040 now return a staff-request fallback but fail the current narrow unsupported-operation observation because they no longer use an unsupported interpretation. Those failures remain visible: the replies do not establish invoice/refund/waitlist support or full topic-specific explanation.

`E2E-311` exercises signed voice and agent-native commands through the same independently authorized Cliniko queue. It covers an approved named person retained across private verification, saved and uncertain results, lost/noncommitted/mismatched responses, disabled/unapproved queues, unknown people, changed approval, permission revocation during dispatch, repeated requests, abandoning private verification, an independently verified clinical workflow, unsent clinical proposal cancellation, and a malicious model staff-send guess. The bounded actual caller request after verification is required before send; classification alone supplies no write consent. Callback recalls use a different approved type from appointment recovery. SAM preserves possible-send fences and exact receipt distinctions, and agent progress strips patient/request detail.

Focused staff, signed call, prior appointment-change, baseline, manifest and type checks provide implementation evidence. The broader voice regression encountered the existing practitioner-eligibility request-count failure at `test/voice/voice.test.ts:1027` (5 requests versus an expected 4), reproduced by the same focused test on unchanged main `17f69c06796baa5f0f988f72d066c91a69e47bb7`. That unrelated assertion is preserved; this patch does not claim a green full suite.

Broader practitioner/location/date-window search, independent appointment enquiries, approved clinic FAQs and topic-specific unsupported explanations remain outstanding. The live runner still does not activate this workflow; clinic acceptance under D-07, real email delivery and real carrier testing remain separate requirements.

The [known-clinical-outcome follow-up](baselines/clinic-conversation-after-staff-v4.json) checks the final resolver after adding an explicit staff-context interpretation for “Did that work?”. It executes all 45 candidates with stable source, zero harness failures, all 135 safety observations and database canaries passing, 23 conversation observations passing and 22 failing, and the same seven setup gaps. E2E-311 separately verifies a real synthetic committed booking followed by independent staff verification/request: the clinical receipt stays identical, and the generic success question answers about the newer staff request. The additional passing observation (CCP-022) is a single-run observation, not a reliability improvement claim.

## Approved start-time windows and bounded later-week searches

[Initial window report](baselines/clinic-conversation-after-windows-v1.json), [known-outcome correction](baselines/clinic-conversation-after-windows-v2.json) and [final-source report](baselines/clinic-conversation-after-windows-v3.json), run on 2026-10-06 with `gpt-4o-mini`, execute all 45 candidates with zero harness failures, stable source, all 135 safety observations passing and clear PostgreSQL patient-data canaries. The initial run records 23 passing and 22 failing conversation observations; the latter two record 24 passing and 21 failing, with seven setup gaps unchanged. Each makes 23 actual candidate model requests; 22 turns use trusted interpretation. The baseline exits nonzero for the remaining failed observations, as intended.

CCP-027 now retains its day and filters actual provider times to starts strictly after 4 pm in the clinic timezone. CCP-028 searches from the day after the rejected menu's final search day through that week's Sunday, with fresh spoken offers and no selection. Their narrow checks now inspect the actual typed window/range and actual spoken provider facts rather than returning an unconditional failure. Other preference, horizon and public-fact observations remain failing; the grader does not count an unrelated fallback as support.

The initial run exposed CCP-045: “after all” was incorrectly treated as an ambiguous clock qualifier, obscuring the committed outcome. The trusted parser now strips this trailing idiom while retaining any preceding real constraint. CCP-045 passes the two follow-ups. E2E-312 separately exercises “after four after all,” a committed booking change request, morning/DST filtering, exact 4 pm exclusion, filtering before the first-three limit, retained/cleared windows, failed/empty reads, unplayed menus, bounded later-week booking/move searches, protected original move targets, fresh confirmation and a host that ignores the requested constraint. The agent commands share that validated seam.

CCP-022's narrow human-route observation, passing in the prior staff report, fails all three window runs: the live model returns a booking outcome for a request to email proof of the booking. It makes no email-delivery claim, but does not establish the required notification-owner explanation or workflow. This remains visible work and illustrates why single-run scores are not a reliability claim. All prose acceptance requirements still remain listed as unassessed. Independent appointment enquiries, approved practitioner/location/service routing, FAQs, richer date language and complete scenario setup remain open; these partial observations do not close the six-part goal or authorize live clinic calls.

Final local gates: `npm run typecheck` passed. `node --test --test-concurrency=3 test/voice/booking-search-windows.test.ts test/voice/openai-clinical-intent.test.ts test/contract/scenario-manifest.test.ts` passed all seven tests, including 16 parallel signed scenarios in E2E-312. The preceding combined E2E-312/309/308/manifest gate passed all six tests. These focused gates do not imply a green full suite or full scenario acceptance.
