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

Three candidate setups require capabilities the current standalone call flow or
baseline fixture cannot supply. The runner exercises a declared substitute
state and reports `setupMatch: false`, an explicit `setupGap`, and a failed
conversation observation. It does not invent staff receipts, public knowledge
approval or additional service authorizations. The recorded earlier reports
retain their original setup gaps; later sections describe which fixtures changed.

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

## Implementation sequence

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

## Approved practitioner preferences and bounded earliest searches

[Source-pinned approved-search report](baselines/clinic-conversation-after-approved-search-v1.json), run on 2026-10-06 with `gpt-4o-mini`, executes all 45 candidates with zero harness failures, stable source, all 135 safety observations passing and clear PostgreSQL patient-data canaries. Twenty candidate turns make actual model requests; 25 use trusted interpretation. Narrow conversation observations improve from 24 to 27 passing, with 18 failing and no previously passing observation regressing in this run. Five setup gaps remain. The report exits nonzero for those failures and remains a partial workflow baseline; all prose acceptance requirements are still unassessed.

CCP-011 now explains the approved current location without silently switching branches. CCP-025 searches only the independently approved requested practitioner. CCP-026 compares every configured approved practitioner within the explicitly spoken range and presents the winner's times. The latter two fixtures now compose actual independent booking authorities rather than assuming missing practitioner approval. The configured catalogue permits one to three practitioners at the admitted location for one appointment type. It does not provide cross-location admission, service selection, unbounded earliest searches or a globally sorted three-option menu.

Each practitioner keeps its own current booking approval, provider binding and writer. An owner-file catalogue supplies public names and search bounds, not patient verification or write permission. One operation-bound patient verifier and one possible-send fence belong to the call. Member reads serialize because their shared verifier's contact recheck is exclusive; independent calls and signed scenarios continue to run in parallel. An unavailable member prevents an earliest/no-match claim. Corrections preserve the selected member, cancel the old proposal and require new exact confirmation; final protected confirmation includes the approved location. Omitted preference dimensions retain their prior values.

`E2E-313` covers 20 signed synthetic-call scenarios plus the agent command path: earlier alternate openings, named preferences, an empty preferred practitioner, failed or changed provider evidence, catalogue and member-policy revocation, a changed patient proof, interrupted menus, retained dates/windows/location, unknown names and other branches, ties, corrections and a response-lost send without replay. The final gate `node --test --test-concurrency=3 test/voice/approved-booking-search.test.ts test/voice/booking-search-windows.test.ts test/voice/openai-clinical-intent.test.ts test/contract/scenario-manifest.test.ts` passed all nine tests; `npm run typecheck` passed.

The remaining setup gaps are CCP-015 (urgent-route fixture), CCP-019 (independent appointment enquiry), CCP-030 (multiple services), CCP-032 (approved public knowledge) and CCP-044 (concurrent pending read). CCP-022's email-proof explanation and the other conversation failures remain unresolved. This patch does not activate a real clinic, email delivery or carrier traffic, and it does not close the six-part goal or claim a green full suite.

## Independent appointment-enquiry follow-up

[Initial enquiry report](baselines/clinic-conversation-after-enquiries-v1.json) and [final date-correction report](baselines/clinic-conversation-after-enquiries-v2.json), run on 2026-10-06 with `gpt-4o-mini`, each execute all 45 candidates with stable source, zero harness failures, all 135 safety observations passing and clear PostgreSQL patient-data canaries. Both record 29 passing narrow conversation observations and 16 failing, with four setup gaps. Twenty candidate turns make actual model requests; 25 use trusted interpretation. Both intentionally exit nonzero for unresolved observations. They do not establish full prose acceptance or release readiness.

CCP-019 now starts in an actual independently verified `appointments.read` owner rather than cancellation-bound verification. Its live-model enquiry uses the clinic-approved upcoming range, speaks the searched dates and actual provider appointment, and prepares no clinical action. That setup gap is removed. CCP-024's missed-call human-route observation also passes both runs, having failed in the preceding approved-search report; this response was not a targeted behavior change and is not a causal reliability claim. No previously passing observation regresses in either run relative to that report.

The independent read owner captures exact current caller/read approvals, patient permission and admitted session bindings. It has no writer, cancellation policy or clinical proof. Existing protected reader limits remain for other compositions; this read approval can authorize a bounded future start within its own horizon. Played ordinal selection re-reads unchanged private appointment evidence. A date correction performs a new read; changed records, unplayed lists, changed contact, revoked permission/admin approval and automation disablement produce no personal appointment detail. A write stop does not itself revoke independently permitted reads. A later booking request needs a separate booking verification, protected offer and freshly played confirmation; no read proof or selection transfers.

`E2E-314` covers 24 parallel isolated signed scenarios, a separate signed enquiry-to-booking journey and the agent commands. The final gate `node --test --test-concurrency=3 test/voice/appointment-enquiries.test.ts test/voice/openai-clinical-intent.test.ts test/contract/scenario-manifest.test.ts` passed all seven tests. The preceding enquiry/existing-reader/manifest gate passed; the enquiry/four-clinical-workflows/call-flow/manifest gate passed all 17 tests including its subtests. `npm run typecheck` passed. Early failures found and corrected a valid read rejected by media-turn clock advancement and a test supplying the policy revision instead of the automation setting revision; their failed runs are not counted as passing evidence.

CCP-015 (urgent-route fixture), CCP-030 (multiple services), CCP-032 (approved public knowledge) and CCP-044 (concurrent pending read) remain setup gaps. The other conversation failures, including CCP-022's email-proof explanation, remain visible. Approved FAQs, service guidance, broader location admission and complete conversational acceptance still need work. The live runner remains unactivated; carrier/email evidence and the documented preexisting broad voice request-count assertion are unresolved.

### Advancing-clock regression

An additional signed journey advances the owner clock by two seconds during model interpretation. On the initially merged enquiry implementation, the protected read succeeds but SAM rejects its observation against the older media-turn timestamp. The follow-up host now supplies a private post-read authority-check timestamp; the turn owner validates the original snapshot at that fresh time, within the existing 30-second request-clock bound. Provider observations remain unchanged, and the existing core future/freshness checks still apply.

E2E-314 now covers 25 isolated signed cases plus the separate signed enquiry-to-booking journey and agent commands. The focused enquiry/model/manifest gate passes all seven tests including the advancing-clock reproduction. The [fresh-clock live report](baselines/clinic-conversation-after-enquiries-v3.json) executes all 45 candidates with unchanged source, zero harness failures, all 135 safety observations and PostgreSQL canaries passing, 29 passing narrow conversation observations and 16 failing, and the same four setup gaps. Its 20 model requests/25 trusted interpretations and every observation's pass/fail status match the preceding final enquiry report; it is not a broader acceptance or reliability claim.


## Approved public clinic FAQs

[Initial FAQ report](baselines/clinic-conversation-after-faqs-v1.json) and
[refined FAQ report](baselines/clinic-conversation-after-faqs-v2.json), run with
`gpt-4o-mini` on 2026-10-06, each execute all 45 candidates with unchanged source,
zero harness failures, all 135 safety observations passing and clear PostgreSQL
patient-data canaries. The initial report records 29 passing narrow observations
and 16 failing, with three setup gaps. CCP-032 now speaks actual synthetic
clinic-approved directions, but CCP-014 regresses to a generic information
unavailable notice for a medical-clearance question. That failure is preserved.

Refinement adds a bounded clinical-advice boundary: matched requests for safety
clearance after treatment direct the caller to their clinician/clinic without
advice, diagnosis or urgency assessment. The refined report records 31 passing
narrow observations and 14 failing, three setup gaps, 19 actual model requests
and 26 trusted interpretations. CCP-032 remains passing and CCP-014 no longer
regresses. CCP-022's generic staff-contact observation also passes this run, but
that was not a notification implementation change and does not prove the
required booking-versus-email explanation or actual delivery. This is neither a
causal reliability estimate nor full prose acceptance; every prose acceptance
requirement remains listed as unassessed. Both reports intentionally exit
nonzero for the unresolved observations.

The FAQ source is an optional operator-provisioned public configuration adapter,
not patient notes or a general persisted knowledge editor. Exact scope, policy
version, owner-only file, current clinic-admin membership, approval and effective
interval are checked. Admission pins versions covering both full source content
and approving membership. An old call cannot adopt changed facts or a new
approval, even when its revision label is reused; a newly admitted call can use
new approved material. Current automation also gates voice and direct agent
reads. The trusted mapper copies exact current facts, then SAM independently
re-reads and validates the source. Unavailable information cannot produce an
invented address. The operator must supply already public facts; schema checks
and approval are not patient-data detection. The existing database knowledge
gate remains closed.

`E2E-315` covers 26 parallel isolated signed-call scenarios and the existing
agent answer command: directions/parking, hours, contact, repetition and
interruption; drafts, revocation, expiration, unreadable/foreign content,
permission changes, text/revision/membership changes, approval changes during
model interpretation, newly admitted replacement facts, automation disablement,
invented model wording and the clinical-clearance boundary. Public answers
create no clinical action or verification email. The final focused gate
`node --test --test-concurrency=3 test/voice/clinic-faqs.test.ts test/voice/openai-clinical-intent.test.ts test/contract/scenario-manifest.test.ts`
passed all six tests. The preceding FAQ/enquiry/model/text-knowledge/manifest
gate passed, and final `npm run typecheck` and `git diff --check` passed.

Remaining setup gaps are CCP-015 (urgent-route fixture), CCP-030 (multiple
services) and CCP-044 (concurrent pending read). Conversation failures, richer
service/location support, actual notifications and full acceptance still need
work. No actual clinic FAQ approval, real email delivery, carrier traffic or
production clinical capability was activated. The previously documented broad
voice request-count assertion remains outside these passing focused gates.


## Date corrections with retained time windows

The signed E2E-316 reproduction initially fails on the merged FAQ source: a
caller changing from a tentative Thursday to Wednesday morning receives a
generic menu clarification. The window parser had considered the whole sentence
while the date-correction parser considered only the final phrase. The fix keeps
the final phrase's recognized date and explicit window together, delegates clock
parsing to the existing bounded window parser, and passes both through fresh
approved search. Ambiguous meridiem and extra qualifiers remain clarification,
not unrestricted searches.

[Source-pinned dated-window report](baselines/clinic-conversation-after-dated-windows-v1.json),
run on 2026-10-06 with `gpt-4o-mini`, executes all 45 candidates with unchanged
source, zero harness failures, all 135 safety observations passing and clear
PostgreSQL patient-data canaries. It records 31 passing narrow conversation
observations and 14 failing, with the same three setup gaps. Nineteen candidate
turns make actual model requests; 26 use trusted interpretation. It intentionally
exits nonzero for unresolved observations and remains partial evidence with all
prose acceptance requirements unassessed.

CCP-004 now uses the final Wednesday morning correction, speaks its local
before-noon constraint and actual eligible Wednesday time, and prepares no
action. Its fixture now provides morning and afternoon evidence on the corrected
day; the named observation is strengthened to check the explicit window and
filtered spoken result in addition to its date. CCP-022's generic contact
observation fails this run after passing the prior FAQ run; no notification
workflow or email explanation was implemented, and that variation remains
visible. The total passing count is unchanged, although the targeted correction
is now verified. No reliability claim is based on these single-run counts.

E2E-316 covers 13 parallel isolated signed scenarios: a verified initial search,
booking/move proposal corrections, retained and explicitly cleared windows,
multiple correction clauses, ambiguous or qualified requests, revoked approval,
unplayed replacement menus/confirmations, a committed receipt and an independent
read request containing an unsupported time filter. Old proposals are fenced
before new reads; a move preserves its exact protected original; replacement
menus/selections/details must be played before a new separate affirmation can
send once. Date-only appointment enquiries clarify a requested time-of-day
filter instead of dropping it and reading the full day.

`node --test --test-concurrency=3 test/voice/dated-window-corrections.test.ts test/voice/caller-corrections.test.ts test/voice/booking-search-windows.test.ts`
passed all five tests. The final dated-window/model/manifest gate passed all five
tests; `npm run typecheck` and `git diff --check` passed. The archived report
matches the final production/fixture/runner source. The unchanged urgent-route,
multiple-service and concurrent-pending-read setups, other conversation failures
and live carrier/email activation still need work; no actual clinic capability
was activated.

## Urgent conversation routing (2026-10-06)

The signed E2E-317 reproduction failed before the change: an explicit urgent-help
request received generic staff-follow-up wording despite the admitted approved
script. The agent response command was also absent. A further forged-model
scenario exposed implicit system-failure staff work with no proven standalone
route. Those failing runs are retained in tracked local logs; they were corrected
rather than relaxing the no-new-task assertion.

The production resolver now selects the existing urgent SAM response with a
bounded explicit cue or a strict structured decision. Only the admitted approved
script can be spoken, checked again at fresh owner time after interpretation.
An active call keeps its admitted script after a setting change, only until its
original validity ends; new calls use the changed setting. No model or agent can
supply wording or authorize a diagnosis, medical clearance or transfer.
Standalone urgency has no approved urgent staff destination, and the ordinary
verified recall workflow does not provide one. The response says a staff request
cannot be sent from this call, creates no ordinary recall or verification email,
and preserves prior committed/uncertain actions and existing review work. Generic
standalone model failure now repairs or directs the caller to the clinic without
claiming staff follow-up; independently verified caller-requested staff work
remains available under its own approval.

[First urgent report](baselines/clinic-conversation-after-urgent-v1.json) preserves
44 executed candidates, one enquiry harness failure, nine failing conversation
observations and two setup gaps. The combined test run also stalled in a booking
selection inside E2E-311 while evaluation and typecheck ran concurrently. No source
changed between these observations and the diagnostic runs. The affected
[isolated enquiry](baselines/clinic-conversation-after-urgent-enquiry-diagnosis-v1.json)
and separate E2E-311 run passed; this is evidence of sensitivity to concurrent
workload, not proof of the precise cause or a full-suite reliability claim.

[Second urgent report](baselines/clinic-conversation-after-urgent-v2.json) executes
all 45 candidates under the unchanged production/fixture/runner source with
`gpt-4o-mini`, zero harness failures, 36 passing named conversation observations,
nine failing and two setup gaps (CCP-030 services and CCP-044 pending concurrent
read). All 135 safety observations pass; PostgreSQL patient-data canaries are
clear and the source remains stable. All prose acceptance requirements remain
unassessed. It intentionally exits nonzero and is not a release gate.

CCP-015 checks the actual approved urgent words, truthful unavailable escalation
and absence of patient work, rather than a generic contact response. The other
new narrow passes do not establish shared-phone authority revocation, booking
versus email-delivery explanation, a new billing feature or complete background
repair acceptance. These need direct behavior checks before being called done.

E2E-317 covers 18 parallel signed scenarios plus agent input/idempotency and
negated/background-language checks. The final urgent/model/manifest/baseline
run passed eight of nine tests; its sole staff-workflow timeout is preserved
above, and `node --test test/voice/cliniko-staff-request.test.ts` passed separately
with scenarios still parallel internally. The earlier urgent/model/staff gate
passed all seven tests. The isolated PostgreSQL embedded urgent/setting gate
passed all ten tests without skips. Final `npm run typecheck` and
`git diff --check` passed. This is focused validation, with the concurrent
workload timeout still a reliability limitation. Carrier, live email and real
clinic activation remain outside this evidence; the six-part goal is not closed.

A final review found that the new agent urgent command needed its own trusted
expiry clock. It now uses the reception/composition clock instead of public
command timestamps. E2E-317 explicitly submits a fresh turn with an old public
timestamp after script expiry and verifies the safe fallback with no task.
The subsequent urgent/model/baseline/manifest gate passed all eight tests; final
owner-clock typecheck and all ten isolated PostgreSQL embedded urgent tests
passed. Earlier archived reports above remain unchanged and precede this final
clock correction; their source hashes must not be presented as the final source.

[Final owner-clock urgent report](baselines/clinic-conversation-after-urgent-v3.json)
now matches all 450 final production/fixture/runner source files. It executes
all 45 candidates, with 36 passing named observations, nine failing, two setup
gaps, zero harness failures, all 135 safety observations passing and clear
PostgreSQL patient-data canaries. Eighteen candidate turns make real model
requests and 27 use trusted interpretation. The additional agent scope/clock
gate passes: another location cannot use the call, an invalid private clock
cannot change state, and backdated public time cannot revive expired wording.
The report stays partial with every prose acceptance condition unassessed; no
single-run reliability or real clinic activation claim is made.

## Booking versus email confirmation questions (2026-10-06)

The E2E-318 signed reproduction failed on the merged urgent source: a committed
booking followed by an email-proof request received generic repair without the
known booking receipt. The new query selects a SAM status response, never a send.
It separately reports the actual latest action and a valid uniquely linked
notification receipt. The action-outcome wording is shared with the existing
ordinary outcome query so cancellation, move and caller-mediated intake retain
their established distinctions.

An unproven standalone path states that the booking is confirmed but email
confirmation cannot be verified or delivered from this call. Approved embedded
receipts can report pending, definitively unsent or reported sent. A sent
notification does not prove an email channel or inbox delivery; its wording says
so explicitly. None of these questions authorizes an email/resend, owner change,
new notification/reconciliation effect or staff request. Previously queued,
authorized reconciliation may drain through the voice runner and its proven
receipt can update a later answer without another send.

The first embedded query assertion incorrectly expected the voice runner to
freeze its already queued reconciliation. That expectation was corrected by
checking unchanged effect IDs, no new send, observation of the exact prior
captured intent and the updated proven receipt on the next question. The query
implementation did not change to force a frozen or fictional delivery status.
Standalone signed and agent paths, which have no pending notification to drain,
still require their effect records to remain unchanged.

E2E-318 covers nine parallel signed standalone scenarios including valid strict
model interpretation, forged model wording and a malformed structured choice.
The agent command denies fabricated receipt/recipient/owner fields, cross-scope
access and backdated access to an expired session lease. Both approved embedded
owners are exercised against memory and PostgreSQL, including receipt updates
and later owner edits. Text tests cover actual pending and definitive-unsent
outbox receipts without dispatch or retry from the query.

The receipt/reconciliation gate passed all 51 tests. The final
language/baseline/manifest/urgent regression gate passed all ten tests; the
memory/PostgreSQL embedded receipt gate passed all 35 tests with no skips. The
additional strict model/forged receipt and agent gate passed both tests.
Final `npm run typecheck` and `git diff --check` passed. CCP-022's named observation
now requires the actual committed booking status, explicit unknown email path
and absence of notification or staff effects instead of generic contact wording.
Live email delivery remains deferred, and this is focused synthetic validation,
not a release gate or full goal completion.

[First notification-query report](baselines/clinic-conversation-after-notification-query-v1.json)
preserves all 45 executed candidates, 35 passing narrow observations and ten
failing, with two setup gaps and no harness failure. All 135 safety observations
pass and PostgreSQL canaries remain clear. CCP-022 now passes the stronger exact
booking-plus-email-status observation. CCP-009 varies back to a generic staff
classification, and CCP-034 incorrectly becomes a booking-notification query;
those results are preserved rather than hidden by the passing target.

The paid-receipt distinction is corrected by bounded routing to the existing
approved staff/contact seam before generic notification classification. A tenth
signed scenario checks that a paid receipt request cannot become a booking-status
answer, send an invoice, look up private billing data or begin unapproved staff
work. Named staff requests retain priority. This does not add a billing feature
or change the receipt-request scorer to award missing capabilities.

The final notification-versus-billing signed/model/staff/baseline/manifest gate
passes all eight tests, including the tenth paid-receipt counterexample and
independent verified staff-request regression. Its final typecheck passes.
The earlier memory/PostgreSQL receipt and reconciliation checks remain valid;
the final routing refinement changes no notification dispatch or storage code.

[Final notification-query report](baselines/clinic-conversation-after-notification-query-v2.json)
matches all 452 final production/fixture/runner source files and executes all
45 candidates with zero harness failures, two setup gaps, all 135 safety
observations passing and clear PostgreSQL patient-data canaries. It records 35
passing narrow conversation observations and ten failing; sixteen candidate
turns make real model requests and 29 use trusted interpretation. CCP-022 uses
the actual committed booking plus unknown email-delivery response, and CCP-034
now uses the existing staff/contact route instead of the wrong notification
query. The invoice scorer still fails rather than awarding an invented billing
capability. CCP-033's unknown-price contact observation varies from the prior
run and remains unresolved. All prose acceptance conditions remain unassessed;
the report intentionally exits nonzero and is not a reliability or release gate.

## Caller identity disagreement and shared-phone denial (2026-10-06)

The E2E-319 reproduction failed on merged source `67750a3`: a verified booking
proposal followed by “that isn't me” received generic repair. There was no
call-wide negative authority transition. The new denial records only its first
reason enum, cancels unsent proposals/model work and permanently revokes patient
access within this call. Cliniko clinical and independently verified staff
owners are disposed through a separate patient lifetime; the whole call remains
available for independently approved public FAQs and the urgent script.

Reception checks precede every patient/model-work host seam, and SAM send
barriers/effect dispatch independently fence new patient work and automatic
reconciliation. Scoped agent progress hides prior patient actions, staff
outcomes and appointment read metadata. An already-sent action is not undone:
existing receipts remain truthful and an actual late receipt may settle its
action without disclosure or a new notification. The caller is directed to
contact the clinic. Standalone Cliniko state remains transient under D-06/D-11;
the PostgreSQL denial round trip tests the authorized embedded contract.

The signed test covers sixteen parallel scenarios including initial and verified
denial, shared-phone statements, strict model paraphrases, forged output,
negated/background counterexamples, booking/cancel/move/enquiry/staff workflows,
prior committed/uncertain outcomes and retained public FAQ/urgent access.
Additional agent tests cover exact input, foreign scope/session, stale private
clock, idempotency, monotonic reasons and refusal to reuse a processed unrelated
turn. A held Cliniko read cannot publish a late menu, private code collection
can be revoked by an authorized command, and a late actual write receipt is
retained without a result announcement to the denied caller.

The first [live intent sample](baselines/clinical-intent-after-identity-v1.json)
passed six of seven checks and exposed a routing defect: a partner/shared-number
statement reached the existing proxy-request boundary before shared-phone
handling. That failed sample is retained. The bounded explicit shared-phone
matcher now takes precedence, while a request to book for a partner remains a
proxy counterexample. The [corrected intent sample](baselines/clinical-intent-after-identity-v2.json)
passes eight of eight samples with seven actual model requests and one trusted
shared-phone route. Both identity-disagreement and less literal shared-line
paraphrases made real model requests. This is a classification sample, not an
audio reliability gate; the earlier report's adapter hash precedes the routing
correction and covers only its original two-file adapter set.

Validation commands and observed results:

- `node --test --test-concurrency=3 test/voice/openai-clinical-intent.test.ts test/voice/conversation-baseline.test.ts test/voice/clinic-faqs.test.ts test/voice/urgent-conversation-routing.test.ts test/voice/cliniko-staff-request.test.ts test/voice/notification-outcome-query.test.ts test/text/notification-effects.test.ts test/text/staff-task.test.ts test/cliniko/cliniko-call-flow.test.ts`: 56 passed.
- `node --test --test-concurrency=3 test/text/caller-identity-denial.test.ts test/voice/conversation-baseline.test.ts test/voice/caller-identity-denial.test.ts test/cliniko/caller-identity-denial.test.ts test/contract/scenario-manifest.test.ts`: seven passed after the denial-aware public-availability fallback correction.
- `node --test --test-concurrency=3 test/voice/caller-identity-denial.test.ts test/voice/openai-clinical-intent.test.ts test/voice/conversation-baseline.test.ts test/contract/scenario-manifest.test.ts`: four passed after the shared-phone precedence correction, including all sixteen signed scenarios.
- `npm run typecheck` and `git diff --check`: passed on the final source.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinical-intent.ts --model gpt-4o-mini --out eval/results/20261006-identity-intent-v14-v2.json`: eight of eight samples passed.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinic-conversations.ts --model gpt-4o-mini --out eval/results/20261006-conversations-identity-v1.json`: intentionally nonzero because named observations remain incomplete.

The [final conversation report](baselines/clinic-conversation-after-identity-v1.json)
matches all 454 production/fixture/runner source files. All 45 candidates execute
with zero harness failures, two setup gaps, all 135 safety observations passing
and clear PostgreSQL patient-data canaries. It records 34 passing narrow
conversation observations and eleven failing. Fifteen candidate turns make real
model requests and 30 use trusted interpretation. CCP-009 now requires actual
identity denial and the exact restricted response instead of generic repair.
The aggregate is not presented as an improvement: CCP-039's paired-practitioner
request now varies to a booking workflow, while minor intake, horizon/service
handling, unknown prices and other unsupported-request observations remain open.
All prose acceptance conditions remain unassessed; this partial report does not
close the six-part goal, clinic activation or real carrier/email testing.
