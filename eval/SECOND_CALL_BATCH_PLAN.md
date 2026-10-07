# Second call batch: implementation and evidence

The operator requested all eighteen scenario families from the conversation
assessment. Work proceeds in the order below. Real transcripts, patient details
and recording links are excluded. The original 45-case corpus and its historical
evidence remain intact; new journeys use synthetic inputs and inspect actual
Cliniko mutation payloads and call receipts.

| Order | Family | Completion evidence |
| --- | --- | --- |
| 1 | Repeated automated hold announcements, keypad scripts and outbound speech repetition | Implemented; E2E-331 passes thirteen signed synthetic journeys; local checks passed; publication prepared |
| 2 | Questions and presence acknowledgements mistaken for consent | Existing exact confirmation preserved; direct E2E-331 offered-time, duration and presence questions pass; local checks passed; publication prepared |
| 3 | Last-moment corrections before and after dispatch | Pending |
| 4 | Vanished slots with retained caller constraints | Pending |
| 5 | Follow-ups after a confirmed action, including canceling the old moved appointment | Pending |
| 6 | Partial menu repetition and incremental navigation | Pending |
| 7 | Compound weekday, time and date constraints | Pending |
| 8 | Relative and source-relative dates and times | Pending |
| 9 | Staff message additions and corrections saved in Cliniko | Pending |
| 10 | Shared phones and changing patient identity | Pending |
| 11 | Bounded pauses, writing time and reopening after goodbye | Pending |
| 12 | External appointment changes and previous-call claims | Pending |
| 13 | Private intake spelling and field repairs | Pending |
| 14 | Payment, deposit, currency, refund and insurance evidence | Pending |
| 15 | Clinical request boundaries and approved routing | Pending |
| 16 | Conflicting public facts and unusable arrival instructions | Pending |
| 17 | Practitioner and service preferences, history and duration | Pending |
| 18 | Home visits, classes, telehealth and practitioner changes | Pending |

Each family needs a baseline observation, implementation where needed, focused
end-to-end evidence, related regression checks and a merged publication. Existing
tests count only when they directly demonstrate the requested journey; coverage
of a neighboring primitive does not establish completion. Synthetic speech and
provider evidence do not establish real carrier, mail or clinic activation.

## First publication: E2E-331

The two failing observations are retained under
`eval/baselines/second-call-batch-automated-before-v1.json` and
`eval/baselines/second-call-batch-batched-before-v1.json`. Complete matched scripts
and exact recent ordinary outbound repetitions bypass interpretation and cannot
confirm an action. Two fixed notices precede terminal closure on the third such
turn. Unsent proposals are canceled first. A single pause can resume with fresh
played offers, a new proposal and a separate exact confirmation. The successful
writer payload is inspected independently of the spoken confirmation.

The guard recognizes wording, not speaker identity or every robocall. It retains
only three recent ordinary outbound messages in live call memory, excludes
private prompts and clears on stop. Neither real patient transcripts nor their
identifiers are included. No prompt/model revision or real delivery is claimed.

Focused regression command (7 tests, 7 pass, 0 fail, 102784.08461 ms):

```sh
node --test --test-concurrency=3 test/voice/automated-call-consent.test.ts test/voice/call-transcript-ownership.test.ts test/voice/caller-corrections.test.ts test/voice/pending-lookup-repair.test.ts test/voice/call-waiting-limits.test.ts test/contract/scenario-manifest.test.ts
```

The design table and scenario manifest add E2E-331 (version 1.129, 331 IDs).
The original 45-case corpus remains unchanged. This publication closes only
families 1 and 2; the other sixteen require their own direct evidence and
implementation where necessary.

A final bounded-parser refinement consumes one hold phrase at a time. The added
long announcement prefix followed by a real request remains an ordinary request
and returns without regex backtracking; its call still cannot confirm a booking.

Final bounded-parser focus: 13 signed journeys pass (26052.396756 ms). Final
manifest contract: pass (1495.818397 ms). Final `npm run typecheck` and
`git diff --check`: pass. Source hashes and scoped evidence are retained in
`eval/baselines/second-call-batch-automated-final-v1.json`. The seven-test regression
preceded the final bounded-parser refinement; the final focus and typecheck
exercise its exact source. No unrelated full-suite or real-model pass is claimed.
