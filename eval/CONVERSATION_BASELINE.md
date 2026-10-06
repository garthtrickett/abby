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

Earlier candidate setups required capabilities the standalone call flow or
baseline fixture could not supply. Those reports retain their declared substitute
states, `setupMatch: false`, explicit `setupGap` and failed observations. The
latest pending-lookup report has no setup gaps. Later sections describe each
fixture change; no report invents staff receipts, public knowledge approval or
additional service authorizations.

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

## Unsupported patient and coordinated appointment requests (2026-10-06)

The E2E-320 reproduction failed on merged source `1ed9106`: a minor/proxy,
combined-patient, paired-practitioner or group-class request could receive an
ordinary booking verification prompt or generic change repair. It was recorded
before production changes (`Abby unsupported booking scope signed reproduction
320`, tracked failed run). These are unsupported in the current self-only adult,
individual-appointment contract; no guardian, representative, joint-availability
or class-booking permission is inferred.

Four typed negative reasons now select exact clinic-contact explanations. SAM
cancels unsent proposals and model work; the host releases unsent private owner,
proof, selections, intake draft and menus using a separate workflow lifetime.
A held read cannot publish its late result. A fresh supported self request needs
fresh independent verification. This does not reset permanent identity denial.
Any prior possible clinical/staff send retains its owner, saved-intake proof,
receipt and authorized reconciliation rather than claiming undo or retry.
Scoped agent commands use strict input, a private lease clock and a minimal
turn/reason negative receipt. Standalone patient/call state remains transient;
PostgreSQL command tests exercise the authorized embedded contract.

The first [live classification sample](baselines/clinical-intent-after-request-boundaries-v1.json)
passed twelve of fourteen checks. A class removal paraphrase was intercepted by
the generic change grammar, while a background partner mention blocked a new
self booking. The failed sample is retained. Class removal now has bounded
negative routing, and the proxy guard checks a requested action/substitution
rather than any later occurrence of the word appointment. The [final sample](baselines/clinical-intent-after-request-boundaries-v3.json)
passes fifteen of fifteen checks: thirteen actual model requests and two trusted
routes. A separate less literal class statement uses the actual model. Corrected
self-only and single-practitioner counterexamples also use actual model requests.
This is a public-language classification sample, not real caller audio evidence.

The expanded signed test initially exposed a fixture error: a fresh booking was
requested from a cancellation-only approval fixture. The test now resumes each
fixture's independently approved self operation and checks new proof and a new
menu/list. It did not add booking approval to the cancellation fixture. An earlier
synthetic outcome assertion also failed because its stub returned unsupported;
that stub now supplies the intended strict outcome enum. These failures were
inspected before rerunning the changed tests.

Validation commands and observed results:

- `node --test --test-concurrency=3 test/text/request-boundary.test.ts test/cliniko/request-boundary.test.ts test/voice/booking-request-boundaries.test.ts test/voice/caller-identity-denial.test.ts test/voice/openai-clinical-intent.test.ts test/voice/conversation-baseline.test.ts test/contract/scenario-manifest.test.ts`: ten passed, including eighteen signed boundary scenarios and sixteen existing identity scenarios.
- `node --test --test-concurrency=3 test/voice/conversation-baseline.test.ts test/voice/appointment-change-intent.test.ts test/voice/cliniko-staff-request.test.ts`: three passed on the final stricter twelve-candidate baseline fixture, protected cancel/move grammar and independent staff flow.
- `npm run typecheck` and `git diff --check`: passed.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinical-intent.ts --model gpt-4o-mini --out eval/results/20261006-request-boundaries-intent-v15-v3.json`: fifteen of fifteen classifications passed with thirteen actual model requests.

Only CCP-012, CCP-013, CCP-037, CCP-039 and CCP-041 now use a specific boundary
observation: correct enum and exact notice, no new provider/mail/write work, no
individual substitute proposal, unchanged sent receipts and released unsent
workflow. Generic unsupported scoring remains unchanged. Billing, waitlist,
service ambiguity, search horizon, unknown price and pending-read setup gaps
remain separate; these tests do not award missing capabilities. Real email,
clinic approval and carrier activation remain open.

The [pre-retry conversation report](baselines/clinic-conversation-after-request-boundaries-v1.json)
matches all 456 production/fixture/runner source files at that checkpoint and executes every
candidate. It records zero harness failures, two setup gaps, all 135 safety
observations passing and clear PostgreSQL patient-data canaries. There are 38
passing narrow conversation observations and seven failing; twelve candidate
turns make real model requests and 33 use trusted interpretation. The five new
boundary observations pass. The remaining failures are CCP-029, CCP-030,
CCP-033, CCP-034, CCP-035, CCP-040 and CCP-044. The invoice/refund/waitlist
cases still fail the unchanged unsupported scorer rather than being promoted to
billing or enrollment capabilities. All prose acceptance conditions remain
unassessed. The evaluation intentionally exits nonzero and remains a partial
baseline, not a clinical reliability or release gate.

Final direct review also found that returning a recorded duplicate turn could
hide a prior failed private cleanup. Same-current-turn retries now repeat the
idempotent negative host release and retain its typed failure until it succeeds;
SAM messages and canceled proposals are still recorded only once. Reuse after
another processed turn is rejected, so a duplicate cannot clear a later self
workflow. The memory/PostgreSQL agent test exercises two failed attempts followed
by successful retries rather than treating the stored turn as a cleanup receipt.

The final cleanup-retry gate passes six tests using
`node --test --test-concurrency=3 test/text/request-boundary.test.ts test/cliniko/request-boundary.test.ts test/voice/booking-request-boundaries.test.ts test/voice/conversation-baseline.test.ts test/contract/scenario-manifest.test.ts`.
Its final `npm run typecheck` and `git diff --check` pass. The [final all-45 report](baselines/clinic-conversation-after-request-boundaries-v2.json)
matches the final 456 production/fixture/runner source files with sourceStable
true. It again records 38 passing named observations, seven failing, zero harness
failures, two setup gaps, all 135 safety observations passing and clear PostgreSQL
patient-data canaries. Twelve candidate turns make actual model requests, with
33 trusted interpretations. Its intentional nonzero result preserves the same
remaining gaps and every prose acceptance condition remains unassessed.

## Approved destination search horizon

The signed-call reproduction on main `a10891c67452c7017319b471de9ac6fc5f3ec64c`
failed before production changes: “Can we move it several months from now?”
received a generic repair instead of the clinic's approved search limits.
Abby now reads current public approvals through a scoped, cancelable host port
and gives a canonical limit explanation without provider, patient or email work.
The agent command is `booking.horizon.read.v1`. Numeric limits are withheld on
revoked membership, changed approvals, expired evidence, foreign bindings or
invalid evidence. An unsent proposal is canceled before the public read;
known sent outcomes remain truthful and a later write needs fresh confirmation.

Precise dated offer requests outside the whole approved range receive the same
typed explanation. Partial ranges continue through ordinary protected offer
filtering. Direct review of the write path established that the rescheduling
policy's advance limit concerns the **original appointment's eligibility**;
the booking policy governs the **destination start**. These are checked
separately, rather than taking a minimum across unlike limits. Selected approved
practitioners retain their individual destination limits.

The first expanded signed fixture failed because its clock jump expired the
entire call lease. The corrected fixture expires only the approval, preserving
the lease guard. The [first model sample](baselines/clinical-intent-after-horizon-v1.json)
also preserves an observed failure: a reported past question from a friend was
classified as the caller's own horizon question (17 of 18 passed). After prompt
refinement, the [second sample](baselines/clinical-intent-after-horizon-v2.json)
passes 18 of 18 with 15 actual model requests. Both are classification samples,
not statistical reliability or clinical acceptance evidence.

Final validation commands and results:

- `node --test --test-concurrency=3 test/text/booking-horizon.test.ts test/cliniko/booking-horizon.test.ts test/voice/booking-horizon.test.ts test/voice/conversation-baseline.test.ts test/voice/approved-booking-search.test.ts test/voice/appointment-change-intent.test.ts test/voice/booking-request-boundaries.test.ts test/contract/scenario-manifest.test.ts`: all 12 tests passed. Coverage includes 16 parallel signed horizon journeys, memory/PostgreSQL agent commands, held public reads, consumer cancellation and existing search/change/boundary behavior.
- `npm run typecheck`: passed on final production and test source.
- `git diff --check`: passed.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinical-intent.ts --model gpt-4o-mini --out eval/results/20261006-horizon-intent-v16-v2.json`: final archived classification sample above; 18 of 18 passed with 15 actual requests.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinic-conversations.ts --model gpt-4o-mini --out eval/results/20261006-conversations-horizon-v1.json`: intentionally nonzero partial baseline, not a release gate.

The [all-45 horizon report](baselines/clinic-conversation-after-horizon-v1.json)
records 39 passing named conversation observations, six failing, zero harness
failures, two setup gaps, all 135 safety checks passing and a clear PostgreSQL
patient-data canary scan. Source remains stable across all 460 recorded
production, fixture and runner files. Eleven candidate turns make actual model
requests and 34 use trusted interpretation. CCP-029 now passes; CCP-030, CCP-033,
CCP-034, CCP-035, CCP-040 and CCP-044 remain visible. Service ambiguity, unknown
fees, invoice/refund/waitlist handling and pending-read setup still need work;
unchanged generic scoring does not award unsupported capabilities. Every prose
acceptance condition remains unassessed. Synthetic signed calls and current demo
approvals do not establish real carrier/email operation or clinic activation.

## Public service descriptions and unknown fees

The valid-call signed reproduction on `082aba2e5d31997e9a122827037f3d9a0df8a898`
failed before production edits: “I do not know which appointment type I need”
received disputed-appointment wording. The existing
[horizon report](baselines/clinic-conversation-after-horizon-v1.json) preserves
that CCP-030 setup gap and the CCP-033 generic-information response. An earlier
new fixture attempted to provision a then-unsupported fourth FAQ topic and
could not admit the call; it was corrected to reproduce the caller response on
a valid existing approval before implementation.

E2E-322 adds exact call-pinned public topics `serviceGuidance` and `priceAndFees`
through the existing operator approval and `knowledge.answer.v2` agent command.
Approved text may describe multiple clinic services; it does not enable a
second booking type or choose a type from symptoms. The actual clinical type,
fee authority, confirmation and writer remain separately protected. Absent,
revoked, changed, expired or forged public evidence gives an explicit unknown
and clinic-contact notice without a patient-specific staff request. Public
queries perform no provider/patient/email work. Admitted pending proposals are
canceled before public host IO, and held reads use fresh owner time, consumer
cancellation and revision fences. Original FAQ topics retain their prior path.

The first expanded signed run found a real routing defect: a symptom story
followed by “Which appointment type should I book?” still matched the disputed
appointment guard. That guard now distinguishes `appointment type` from an
existing appointment. Later fixture failures are also retained in the tracked
work logs: a spoken question attempted during the private keypad-code lane, a
denial setup whose synthetic model returned the wrong cue, and interruption
after playback was already acknowledged. The fixtures now complete private
verification, assert actual denial before the public question and interrupt
active playback before acknowledging it. Ordinary spoken questions during
private keypad entry are not claimed as supported by this patch.

The [first real classification sample](baselines/clinical-intent-after-public-information-v1.json)
passes 23 of 25 with 20 actual requests, but regresses adult registration and
explicitly negated joint attendance. A bounded diagnostic saw registration
returned as `minorIntake` with an invalid nonnull `intake` operation in about
1.6 seconds, within the unchanged production five-second deadline. The
[second sample](baselines/clinical-intent-after-public-information-v2.json)
passes 22 of 25: the first prompt correction overgeneralized registration and
returned intake for ordinary self-booking. The refined distinction in
`clinical-intent-v19` [passes 25 of 25](baselines/clinical-intent-after-public-information-v3.json),
with 20 actual model requests and five trusted routes. All failed samples remain
archived; one passing sample does not establish statistical reliability.

The [all-45 public-information report](baselines/clinic-conversation-after-public-information-v1.json)
records 41 passing narrow conversation observations, four failing, zero harness
failures, one explicit setup gap, all 135 safety checks passing and a clear
PostgreSQL patient-data canary scan. Source is stable across all 463 recorded
production/fixture/runner files. Ten candidate turns make actual model requests
and 35 use trusted interpretation. CCP-030 now starts before verification with
approved descriptions of Initial visit and Follow-up visit, without authorizing
another clinical type. CCP-033 retains an absent price/fee source and must
explicitly explain the unknown rather than infer a quote or waiver. The new
checks require exact topic/text, no provider/mail/write work, unchanged
actions/staff items and the appropriate recorded knowledge evidence.

CCP-034, CCP-035, CCP-040 and CCP-044 still fail. Invoice/refund/waitlist cases
retain the existing generic scorer; no billing, refund or waitlist capability
is awarded. The concurrent pending-read setup remains absent. Every prose
acceptance condition remains unassessed. The evaluator intentionally exits
nonzero as a partial baseline, not a release gate. Actual clinic activation,
carrier audio and real email operation remain separately unverified.

Validation commands and results for this change:

- `node --test --test-concurrency=3 test/text/public-service-information.test.ts test/cliniko/public-service-information.test.ts test/voice/public-service-guidance.test.ts test/voice/clinic-faqs.test.ts test/voice/appointment-change-intent.test.ts test/voice/conversation-baseline.test.ts test/contract/scenario-manifest.test.ts`: eight of nine tests passed; the new signed test then exposed the incomplete synthetic denial setup described above. The other eight include parallel memory/PostgreSQL commands, three held-source interleavings, existing FAQ/change behavior and the fifteen-candidate scripted baseline.
- `node --test test/voice/public-service-guidance.test.ts`: both tests passed after correcting denial and active-playback fixture state; the expanded test runs 27 independent signed scenarios with four workers.
- `node --test --test-concurrency=3 test/voice/openai-clinical-intent.test.ts test/contract/scenario-manifest.test.ts test/voice/public-service-guidance.test.ts`: final v19 gate passed all six tests, including strict malformed/forged/wrong-phase model rejection, prompt cancellation and the corrected signed journeys.
- `npm run typecheck` and `git diff --check`: passed on final source.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinical-intent.ts --model gpt-4o-mini --out eval/results/20261006-public-info-intent-v19-v3.json`: 25 of 25 classifications passed with 20 actual model requests; earlier v17/v18 failures are archived above.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinic-conversations.ts --model gpt-4o-mini --out eval/results/20261006-conversations-public-info-v1.json`: all 45 executed with stable source and the 41/45 named result above; intentionally nonzero for four remaining observations.

Final direct review corrected the synthetic published service text: “I have not
selected an appointment type for you” could misdescribe an earlier committed
booking. It now describes the information's scope instead: “These descriptions
do not select an appointment type or reserve a time.” The signed test rerun
passes both tests, including committed/uncertain outcomes and all 27 scenarios.
The [final all-45 report](baselines/clinic-conversation-after-public-information-v2.json),
produced with the same command and output
`eval/results/20261006-conversations-public-info-v2.json`, matches the final 463
source files with sourceStable true. It retains 41 passing observations, the
same four failures, one setup gap, zero harness failures, all 135 safety checks
passing and clear PostgreSQL patient-data canaries. Ten turns make actual model
requests and 35 use trusted routes. This wording correction does not turn public
descriptions into appointment selection or expand the unassessed acceptance scope.


## Finite staff-request purpose refinement — 2026-10-06

The [before-change signed reproduction](baselines/staff-request-purpose-before-v1.json)
failed on main `b1f4e89`: one independently verified invoice request created a
Cliniko recall, but its summary lost the invoice purpose. No clinical write was
made. The fix carries only `invoiceCopy`, `chargeReview` or `waitlistInterest`
through the existing staff operation, never an amount, document, recipient,
refund authorization, appointment correction, enrollment or callback promise.
The purpose lives transiently or in the approved Cliniko-owned recall.

The first [live classification sample](baselines/clinical-intent-before-staff-purpose-v1.json)
passed 32/33 with v20. The paid-account-paperwork paraphrase returned generic
`staffRequest`, losing its invoice category. This failure was preserved before
v21 clarified proof-of-payment and already paid billing paperwork. The
[refined sample](baselines/clinical-intent-after-staff-purpose-v2.json) passed
33/33 with 25 actual model requests; eight cases used trusted routes. The full
sample includes all prior language cases plus three exact purposes, three model
paraphrases and quoted/negated invoice counterexamples. This remains a small
classification sample, not proof of general language accuracy.

The [all-45 baseline](baselines/clinic-conversation-after-staff-purpose-v1.json)
executes 45/45 with **44 passing named observations**, all **135 safety checks
passing**, zero harness failures, one setup gap, clear PostgreSQL patient-data
canaries and sourceStable true across 466 production/support/script inputs.
Eight candidate turns make actual model requests and 37 use trusted routes.
CCP-044 still fails because the serialized setup does not reproduce an active
pending availability read. The evaluator intentionally exits nonzero for that
remaining observation.

CCP-034/035/040 retain their original absent billing/refund/waitlist authorities.
Their updated named check requires the exact typed purpose and purpose-specific
unavailable response, unchanged actions/staff items, and no additional provider,
mail or write work. It awards no billing delivery, refund or waitlist workflow.
Separate approved-queue signed tests prove that the finite purpose can reach a
verified Cliniko recall. Every corpus prose acceptance condition remains
explicitly unassessed; 44/45 is a partial baseline, not a release gate.

Local test refinement also corrected three fixture assumptions: the reference
host exposes tasks through a method; a synthetic call ID must not contain its
purpose when checking progress redaction; and an earlier clinical booking can
already have its own Cliniko review recall. New staff sends are counted against
that known prior baseline. Exact read reconciliation can change an uncertain
item to saved without a second POST, while speech may conservatively report the
uncertainty until the next status turn. The assertions retain both truthfulness
and no-duplicate-send requirements. Parallel workers settle before disposable
PostgreSQL cleanup.

Validation commands and results:

- `node --test --test-concurrency=3 test/text/staff-request-purpose.test.ts test/voice/staff-request-purpose.test.ts test/voice/conversation-baseline.test.ts test/voice/openai-clinical-intent.test.ts test/contract/scenario-manifest.test.ts`: passed all nine tests before the final prompt refinement, including 29 expanded signed scenarios, scoped memory/PostgreSQL commands, three held preparation interleavings and eighteen scripted corpus cases.
- `node --test --test-concurrency=3 test/text/staff-request-purpose.test.ts test/voice/staff-request-purpose.test.ts test/voice/cliniko-staff-request.test.ts`: passed four of five after fixture correction; the remaining failure was the call-ID redaction fixture described above. The signed purpose scenarios and existing twenty-case generic/person/receipt regression passed.
- `node --test --test-concurrency=2 test/text/staff-request-purpose.test.ts test/voice/openai-clinical-intent.test.ts`: final v21 strict gate passed all six tests, including malformed/null host replies and forged model clinical/patient/free-text fields.
- `npm run typecheck` and `git diff --check`: passed on final source.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinical-intent.ts --model gpt-4o-mini --out eval/results/20261006-staff-purpose-intent-v21-v2.json`: 33/33 classifications passed; earlier v20 failure is archived above.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinic-conversations.ts --model gpt-4o-mini --out eval/results/20261006-conversations-staff-purpose-v1.json`: all 45 executed with stable source and the intentionally nonzero 44/45 partial result above.

E2E-323 and manifest 1.118 record the new feature. Rich PostgreSQL corruption
checks use the deliberately unsafe lab contract rather than granting standalone
permission to store purpose-bearing calls. Actual clinic approval, real email
and carrier audio remain separately unverified. Next is a real pending-read
fixture for CCP-044, followed by assessing the still-unassessed prose conditions.


## Concurrent pending-lookup repair — 2026-10-06

The [before-change signed reproduction](baselines/pending-lookup-before-v1.json)
failed on main `b3a8b21`: a caller asking “Are you still there?” could not produce
its new transcript or repair response before an actual availability read's
held synthetic response was released. The provider deliberately ignored abort;
no clinical write occurred. This established the failure before production edits.

Booking/rescheduling menus, choices and direct appointment proposals now share
an owned voice cancellation signal. Qualified speech releases the current read
consumer before serialized processing continues. The existing fifteen-second
read deadline, session, policy, revision and played-confirmation checks remain.
Late results cannot create speech/proposals or overwrite/clear a fresh menu.
The call-flow appointment-change adapter now forwards the signal it previously
lost; expanded move-choice tests exposed that omission. Subthreshold noise
retains the original read, and disconnect fences transient work.

Presence uses a finite public reply rather than a made-up lookup status or
appointment result. Whole current questions have trusted parsing; paraphrases
can select strict model kind `presence`, with every other field null. The native
`calls.presence.respond.v1` command uses scoped current sessions and a private
clock, rejects extra script/reference fields, remains public after identity
denial, and restores no patient authority. A negative presence turn cancels
unsent proposals and preserves existing send receipts. Intake proposal reads
have not been added to this appointment-lookup cancellation slice.

The [v22 live classification sample](baselines/clinical-intent-after-pending-lookup-v1.json)
passes **37/37**, with **28 actual model requests** and nine trusted cases. Four
new cases cover the exact question, a connection/hearing paraphrase, quoted
past speech and a negated presence question followed by self-booking. This is a
small sample, not statistical proof of general language understanding.

The [all-45 live baseline](baselines/clinic-conversation-after-pending-lookup-v1.json)
executes **45/45 named conversation observations successfully**, with **135/135
safety observations passing**, **zero harness failures**, **zero setup gaps**,
clear PostgreSQL patient-data canaries and stable source across **468 inputs**.
Seven candidate turns make actual model requests; 38 use trusted interpretation.
CCP-044 starts the actual signed availability read concurrently, asks the corpus
question while the response is held, observes cancellation before release, then
checks no late speech/menu, exactly one availability read and unchanged
clinical/staff state. The corpus and original prose requirements are unchanged.

Test refinement preserved real preconditions: the native lab fixture needed
booking enabled at the current policy revision, explicit embedded staff-work
approval, and a started/played greeting before entering a menu. A fresh target
query may legitimately repeat the old date, so its assertion checks preserved
fresh menu/state after the old response releases rather than banning that date
in the newly requested result. Failed fixture gates remain failures, not passing
evidence. All parallel workers settle before disposable PostgreSQL cleanup.

Validation commands:

- `node --test test/text/conversation-presence.test.ts`: passed both native command and four held menu/proposal modes after the fixture corrections.
- `node --test --test-concurrency=3 test/text/conversation-presence.test.ts test/voice/pending-lookup-repair.test.ts test/voice/conversation-baseline.test.ts test/voice/openai-clinical-intent.test.ts test/contract/scenario-manifest.test.ts`: final focused gate passed all eleven tests, including the 23 expanded signed scenarios and nineteen scripted corpus cases.
- `node --test test/voice/pending-lookup-repair.test.ts`: passed the original concurrent reproduction and 23 expanded signed scenarios after the concrete rescheduling signal fix.
- `node --test --test-concurrency=3 test/text/conversation-presence.test.ts test/voice/caller-corrections.test.ts test/voice/appointment-change-intent.test.ts test/voice/conversation-baseline.test.ts`: the signed correction, cancel/move and nineteen-case scripted baseline regressions passed; its new native hold fixture failed before the approval/playback corrections above.
- `npm run typecheck` and `git diff --check`: passed.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinical-intent.ts --model gpt-4o-mini --out eval/results/20261006-pending-lookup-intent-v22-v1.json`: passed 37/37.
- `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinic-conversations.ts --model gpt-4o-mini --out eval/results/20261006-conversations-pending-lookup-v1.json`: passed the partial baseline above with unchanged source.

E2E-324 and manifest 1.119 record the feature. Rich PostgreSQL native fixtures
use the explicit unsafe lab contract; standalone durable patient storage remains
limited to phone-to-Cliniko-ID links. Real carrier timing, clinic activation and
email delivery remain unverified. All corpus prose acceptance conditions remain
explicitly unassessed: **45/45 named observations do not close the six-part goal
or establish release readiness**. Next is a requirement-by-requirement acceptance
audit, adding actual workflow evidence for material gaps without relaxing the
original requirements.


## Acceptance audit and unknown missed-call reason — 2026-10-06

The [working acceptance audit](CONVERSATION_ACCEPTANCE_AUDIT.md) preserves all
45 cases and all 124 original required/forbidden clauses. Inspecting the actual
CCP-024 reply exposed a concrete behavior gap hidden by the previous broad
human/contact regex: generic misunderstanding was counted as a successful
explanation of an unknown outbound-call reason. The [signed before-change
reproduction](baselines/missed-call-before-v1.json) failed on main `912b13a`
before changing behavior. No patient read or outbound-call reason authority was
invented to fix that response.

Missed-call questions now select finite public `missedCall` and canonical
`missedCallReasonUnavailable` speech. The reply explicitly says the clinic's
reason is unknown and offers direct clinic contact. Current trusted whole
questions bypass model interpretation; paraphrases can use strict model kind
with all other fields null. Quoted/past questions, negated questions followed
by booking, and explicit current human requests retain their own interpretation.
Native `calls.missedCall.respond.v1` and voice use a shared private-clock,
scoped-session, clear-final public-repair guard. Identity denial stays intact,
unsent proposals are superseded and existing sent clinical receipts remain.

The first [expanded live sample](baselines/clinical-intent-missed-call-v23-before-refinement.json)
passed 40/41: the already-paid-account-paperwork paraphrase became generic
`staffRequest` rather than `invoiceCopy`. Its failure is preserved. Version 24
clarifies that a finite request purpose takes precedence over generic human
wording. The [refined sample](baselines/clinical-intent-after-missed-call-v24-v2.json)
passes **41/41**, with **31 actual model requests** and ten trusted cases. Four
new cases cover the reason question, a model paraphrase and reported/negated
counterexamples. A passing repeat does not establish statistical reliability.

The [v24 all-45 baseline](baselines/clinic-conversation-after-missed-call-v24-v1.json)
passes **45/45 named observations** and **135/135 safety observations**, with
zero setup gaps/harness failures, clear PostgreSQL canaries and stable source
across **469 inputs**. Six candidate turns make actual model requests; 39 use
trusted interpretation. CCP-024 now requires the exact typed unknown-reason
reply, no additional provider/mail/write work, unchanged clinical/staff state
and no additional appointment/knowledge observations. Original corpus prose and
source candidates remain unchanged and explicitly unassessed.

Fifteen expanded signed scenarios test exact and paraphrased questions, public
identity denial, unsent proposals, committed and uncertain clinical outcomes,
saved/recovered/unresolved staff requests, reported/negated context, an explicit
human request and forged model script/operation fields. A fixture assumption
initially rejected valid independent recovery of the exact prior recall. The
corrected test accepts only that existing task's exact provider observation,
requires precisely the previously authorized patient-contact/recall GETs, and
asserts a single prior recall POST, no new verification, no clinical send and
no fabricated outbound reason. Unknown absent records stay unresolved.
This permits existing authorized reconciliation, not a patient read triggered
by the public reply. Other reason cases require unchanged provider read count.

Validation commands/results are recorded with the final focused gate before
publication. E2E-325 and manifest 1.120 map native memory/PostgreSQL and signed
voice evidence. Native rich-state storage retains the unsafe lab contract;
standalone durable storage remains phone-to-Cliniko-ID links only.

The audit remains open: CCP-017 does not yet convey its approved review cadence;
CCP-007 needs the full stale-menu/fresh-representation sequence; CCP-043/044
need direct ownership/approved-limit evidence; explicit AM/PM clarification
needs inspection. These are concrete local follow-ups, not a reason to claim
release readiness or completion from the passing partial baseline. Real carrier
calls, email delivery, clinic activation and audible pace remain separately
unverified.


Missed-call final validation:

- `node --test --test-concurrency=3 test/text/missed-call-repair.test.ts test/voice/missed-call-repair.test.ts test/voice/conversation-baseline.test.ts test/voice/openai-clinical-intent.test.ts test/contract/scenario-manifest.test.ts test/text/conversation-presence.test.ts test/voice/pending-lookup-repair.test.ts test/voice/played-menu-selection.test.ts test/voice/caller-corrections.test.ts test/voice/appointment-change-intent.test.ts test/voice/cliniko-staff-request.test.ts`: all 18 tests passed, including the fifteen new signed scenarios and twenty scripted corpus cases.
- `npm run typecheck`: the first expanded gate passed; the later gate found that a common booking/staff fixture union lost its typed `staffPosts` member. The fixture now preserves a separately typed staff handle. This is a test-typing correction, not an altered response or authority rule; the final `npm run typecheck` passed after that correction.
- Live commands: `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinical-intent.ts --model gpt-4o-mini --out eval/results/20261006-missed-call-intent-v24-v2.json` passed 41/41 after the archived v23 40/41 failure; `node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinic-conversations.ts --model gpt-4o-mini --out eval/results/20261006-conversations-missed-call-v24-v1.json` passed the stable-source partial baseline above.

- Final typed-fixture `node --test test/voice/missed-call-repair.test.ts`: both tests and all fifteen expanded signed cases passed; `git diff --check` passed.


## Current approved staff review expectations — 2026-10-06

CCP-017's required process expectations were absent on main `cd47930`. The
[signed before-change witness](baselines/staff-review-expectations-before-v1.json)
records an exact saved receipt, one synthetic recall POST and no clinical write,
but no approved 30-minute cadence. The original requirement and corpus remain
unchanged. The named grader now explicitly requires the current approved cadence,
exact saved status, no staff-read/callback claim and no pending clinical action.

E2E-326 adds an optional finite public process snapshot to an exact opened
receipt. Later status/repeated request queries use a bounded current read of
approval, policy and session; no patient lookup, verification email or new send
is needed. Missing or changed approval removes process wording, preserving the
truthful saved receipt. Review cadence is an approved process expectation, not
a claim that staff actually read the request or a promised response time.
Reviewer/backup identities and patient/provider details never enter that public
snapshot or agent progress. No migration, generated type or durable call-state
field is introduced.

Ten parallel signed cases cover current/repeated status, changed/revoked/expired/
disabled approval, unavailable metadata, revocation after exact provider
acknowledgment, an uncertain send and interruption before a held read releases.
Native memory and explicit unsafe PostgreSQL lab cases cover exact public shape,
foreign task/scope/session/policy, finite cadence and timestamps, duplicate turns,
caller-clock replay, held read cancellation, revision, lease expiry, and disabled
or unavailable current policy. All workers settle before fixture teardown.
Actual PostgreSQL canary scanning excludes protected patient data.

The first source gate failed because the new class used TypeScript constructor
parameter properties unsupported by Node's strip-only execution; explicit fields
fixed that error. The first broader regression passed 24/25: the existing human-
receipt guard rejected the word “guarantee” even in a negated sentence. Its
assertion is unchanged. Public wording now says “This does not promise a response
time.” The refined regression passed all 25 tests, including the ten new signed
cases and twenty scripted corpus cases. The original behavior failure remains
archived; neither fixture checks nor safety assertions were relaxed.

Commands:

- `node --test --test-concurrency=2 test/voice/staff-review-expectations.test.ts test/text/staff-review-expectations.test.ts`: passed both new tests before the later policy-refresh exception refinement.
- `node --test --test-concurrency=3 test/text/staff-review-expectations.test.ts test/voice/staff-review-expectations.test.ts test/text/staff-request-purpose.test.ts test/voice/staff-request-purpose.test.ts test/voice/cliniko-staff-request.test.ts test/text/staff-task.test.ts test/voice/conversation-baseline.test.ts test/voice/openai-clinical-intent.test.ts test/contract/scenario-manifest.test.ts test/voice/pending-lookup-repair.test.ts test/voice/missed-call-repair.test.ts`: refined gate passed 25/25, zero skips/cancellations.

The final `npm run typecheck` and `git diff --check` pass. The [strengthened
all-45 baseline](baselines/clinic-conversation-after-staff-review-v24-v1.json)
passes 45/45 named observations and 135/135 safety observations, with zero setup
gaps or harness failures, clear PostgreSQL canaries and unchanged source across
471 inputs. Six candidate turns make actual model requests and 39 use trusted
interpretation; prompt v24 is unchanged. This is narrower than all original
acceptance prose. The exact command was:

```sh
node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinic-conversations.ts --model gpt-4o-mini --out eval/results/20261006-conversations-staff-review-v24-v1.json
```

Manifest 1.121 maps E2E-326. Original corpus prose
remains explicitly unassessed in the partial evaluator. The acceptance audit
still requires the stale-menu sequence, transport ownership/approved termination
limits, meridiem clarification and remaining clause-by-clause inspection. Real
clinic approval, carrier calls, email delivery and audible pace remain separate
release evidence.


## Stale-menu recovery acceptance proof — 2026-10-06

The CCP-007 named observation only checked clarification. E2E-327 now exercises
the full original requirement and prohibition through actual signed HTTP/WS
Cliniko workflows: old played menu, a different newer menu or expired offers,
old reference, clarification and denial before fresh representation, new read
and played options, exact current proposal, separately played confirmation,
and one inspected booking after a separate affirmative. Every original offered
start is excluded from successful proposal evidence. No production behavior
change was required: all six corrected connected journeys pass on main 903bcda.
The [sequence evidence](baselines/stale-menu-sequence-before-v1.json) records the
base revision and added test's separate hash.

The six modes cover supersession, expiry with an independently active call and
proof, interrupted fresh menu, interrupted fresh confirmation, a selected slot
removed at the provider before revalidation, and repeated final affirmation.
Interrupted confirmation cancels its action and requires a new proposal. A
vanished time cannot be confirmed; another representation uses the newly
available start. Model replies deliberately guess ordinal two for unrecognized
selections; they cannot bypass the private played-menu matcher. Old native host
menu bindings are denied without a SAM change. Private OTPs stay out of ordinary
transcripts and PostgreSQL patient-data canaries remain clear.

The first test incorrectly probed a denied native selection before ordinary
caller recovery. The host intentionally clears spoken state on denial, changing
the fixture under test. The corrected test probes that fault after the ordinary
voice turns. Presentation assertions use the actual hashed notice ID helper.
This was a fixture failure, not evidence of a production gap. All parallel
workers settle before disposable PostgreSQL cleanup.

Commands and evidence:

- `node --test test/voice/stale-menu-recovery.test.ts`: corrected connected gate passed all six modes on existing behavior.
- `npm run typecheck`: passed with the new connected test.
- `node --test --test-concurrency=3 test/voice/stale-menu-recovery.test.ts test/voice/played-menu-selection.test.ts test/voice/caller-corrections.test.ts test/voice/dated-window-corrections.test.ts test/voice/appointment-change-intent.test.ts test/voice/cliniko-staff-request.test.ts test/voice/staff-review-expectations.test.ts test/voice/conversation-baseline.test.ts test/contract/scenario-manifest.test.ts`: all nine tests passed, with zero skips/cancellations.
- `git diff --check`: passed. Manifest 1.122 maps E2E-327.

The source inputs of the existing [45-case baseline](baselines/clinic-conversation-after-staff-review-v24-v1.json)
are byte-for-byte unchanged: 471 inputs, SHA-256
`768ac6691b1a34ada042f04c21ed973e86bd29d1e7ba934f307b576a7e910648`.
Its 45/45 named and 135/135 safety observations remain the partial baseline;
no redundant live model run is presented as new language-understanding evidence.
The connected sequence supplies the previously missing acceptance evidence,
not a replacement corpus or relaxed required/forbidden clause. Native commands
retain their earlier independent fixture coverage; this new journey proves the
standalone voice composition and includes a denied native host selection.
Caller-ownership/approved-limit proof, explicit meridiem wording and remaining
clause inspection stay open. Real carrier/audio, delivery and clinic approval
remain outside these synthetic observations.

## Protocol ownership and actual waiting limits — 2026-10-06

E2E-328/329 close the missing direct setup/limit evidence for CCP-043/044
on existing main 3bfaf74 behavior. No production source or privacy permission
changed. The [source-pinned witness](baselines/call-ownership-waiting-before-v1.json)
records the base, separate fixture/test hashes and the actual finite paths.

Eight signed proposed-call journeys cover foreign session, old/future
generation, a mixed valid/foreign final batch, foreign stream, outbound track,
owned unrelated background text and unclear affirmation. Six foreign protocol
faults close with code 1008, unchanged unconfirmed action records, no new
processed turns, model requests, provider traffic or host-write effects, and
terminal caller-message redaction. The two owned-text cases clarify and cancel
the unsent proposal. Protocol ownership does not prove physical speaker identity.

The first ownership runs failed two overspecified fixture assertions: expecting
an ended unconfirmed action to become canceled, then expecting ended caller text
to be retained. Existing terminal contracts instead fence authority through the
ended lifecycle and redact caller text. Corrected assertions pass all eight
cases without modifying production behavior. These failures are not presented
as product defects. Test-only snapshots occur just before real transient ledger
disposal and remain synthetic fixture memory.

The held-provider deadline journey closed after 15,033 ms with code 1008; it did
not fabricate a waiting result. The presence journey replied while the provider
remained held, then used the default 15-second retry and 15-second final notice,
with actual played marks, closing after 30,239 ms with code 1000. Timers were
neither manually fired nor shortened. The provider ignored cancellation and was
released only after closure; no late speech or private menu context appeared.
Both journeys created no action, staff request or clinical write. Parallel
workers settled before disposable PostgreSQL teardown, and patient canaries
were clear; private codes were excluded from ordinary transcripts.

Commands and results:

- `node --test test/voice/call-transcript-ownership.test.ts`: passed after the fixture assertion corrections.
- `node --test --test-concurrency=2 test/voice/call-transcript-ownership.test.ts test/voice/call-waiting-limits.test.ts`: first run proved existing waiting behavior; ownership failures are described above.
- `node --test --test-concurrency=3 test/voice/call-transcript-ownership.test.ts test/voice/call-waiting-limits.test.ts test/voice/media-turn-controller.test.ts test/voice/twilio-media-stream.test.ts test/voice/transport-media-normalizer.test.ts test/voice/pending-lookup-repair.test.ts test/voice/caller-corrections.test.ts test/voice/stale-menu-recovery.test.ts test/voice/conversation-baseline.test.ts test/contract/scenario-manifest.test.ts`: 23 passed, zero failures, skips or cancellations.

Manifest 1.123 maps E2E-328/329. These tests strengthen specific original clauses;
remaining acceptance clauses are still open. Actual clinic approval, real email,
carrier calls and audible behavior remain separate release evidence.

Final typecheck and `git diff --check` passed. A fresh full run used
`node --env-file=/home/gust/code/abby/.env scripts/evaluate-clinic-conversations.ts --model gpt-4o-mini --out eval/baselines/clinic-conversation-after-ownership-waiting-v24-v1.json`.
The [new stable baseline](baselines/clinic-conversation-after-ownership-waiting-v24-v1.json)
passed 45/45 named and 135/135 safety observations, with zero setup gaps or
harness failures and clear PostgreSQL canaries. It records 471 source inputs
with SHA-256 `972ca630e4f0e8f04754bf88bf69df35bb667e93e6cc9e34df487ae04ee79a8e`;
source stability was checked across the run. Six candidate turns made real
model requests; 39 used trusted decisions. Pinned setup decisions are synthetic.
The separate original prose clauses remain unassessed in this report; passing
named observations do not sign off all 124 acceptance clauses.
