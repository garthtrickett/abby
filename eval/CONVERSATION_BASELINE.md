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
