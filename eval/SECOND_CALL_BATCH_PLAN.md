# Second call batch: implementation and evidence

The operator requested all eighteen scenario families from the conversation
assessment. Work proceeds in the order below. Real transcripts, patient details
and recording links are excluded. The original 45-case corpus and its historical
evidence remain intact; new journeys use synthetic inputs and inspect actual
Cliniko mutation payloads and call receipts.

| Order | Family | Completion evidence |
| --- | --- | --- |
| 1 | Repeated automated hold announcements, keypad scripts and outbound speech repetition | Implemented; E2E-331 passes thirteen signed synthetic journeys; merged in PR #421; local checks passed |
| 2 | Questions and presence acknowledgements mistaken for consent | Existing exact confirmation preserved; direct E2E-331 offered-time, duration and presence questions pass; merged in PR #421; local checks passed |
| 3 | Last-moment corrections before and after dispatch | Implemented; E2E-332 passes six signed synthetic journeys; merged in PR #422; local checks passed |
| 4 | Vanished slots with retained caller constraints | Implemented; E2E-333 passes seven signed synthetic journeys; publication pending |
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

PR #421 merged at `f828fa73991d20b67bd7030bd4978bff886e19e4`. GitHub jobs were
blocked before starting by account billing/spending limits; the operator
authorized normal merge on passing local checks. No CI pass is claimed.

## Final negatives: E2E-332

A trailing “no”, “wait”, or “don't book/send/do it” now enters the existing
correction path after a clock self-correction. Before sending, a new proposal
and separate confirmation are required. After one possible send, the reply names
the known confirmed or unknown outcome and directs the caller to the clinic
without another mutation or a false cancellation. Curly apostrophes normalize
to the same bounded syntax; no model prompt or clinic policy changes.

The baseline generic-wording failures are preserved. Its dispatch observation
is qualified separately: a duplicate played marker caused a transport failure,
so it did not establish that the correction was heard. The repaired synthetic
fixture returns only outstanding marks and the clear fence, and requires a
reply after the fence. All six final journeys assert an owned final transcript,
actual provider payload/count, unchanged receipt and a clean patient-data scan.

Files: `src/standalone/caller-correction.ts`, the signed voice fixture and new
`test/voice/final-negative-corrections.test.ts`, design/manifest E2E-332 (version
1.130, 332 IDs), contract and scoped baseline/evidence documents. No real
carrier, email, clinic activation or full real-model pass is claimed.

Final focused run: 1 pass / 0 fail, six signed journeys (13013.629743 ms).
Related regression: 8 pass / 0 fail (86325.519908 ms):

```sh
node --test --test-concurrency=3 test/voice/final-negative-corrections.test.ts test/voice/caller-corrections.test.ts test/voice/dated-window-corrections.test.ts test/voice/automated-call-consent.test.ts test/voice/notification-outcome-query.test.ts test/contract/scenario-manifest.test.ts
```

`npm run typecheck` and `git diff --check`: pass. Exact source hashes and
validation scope are in `eval/baselines/second-call-batch-final-negative-final-v1.json`.

## Retained refresh: E2E-333

Bounded “please check again” / “refresh the options” wording now requests a new
read using the prior played search's actual dates and window. It bypasses model
date guesses, leaves practitioner/location authority in the existing approved
host, and never retries a send. No previous played search gives clarification.
A committed or unknown action keeps its existing outcome and clinic-contact
path. Fresh options and a separate played confirmation remain required.

A failed destination selection previously discarded the rescheduling source.
The private menu now keeps its exact consumed selection turn with that source.
Only a read immediately following that turn can recover it, and fresh patient
proof and source validation must pass before destination availability is read.
The source reference is call-local and clears on disposal; no durable patient
state or host write authority is added.

The actual before report captures classifier HTTP and provider queries: the
old refresh searched October 16 after a November 2–8 offer. Earlier fixture
reports are preserved and qualified: an initial month-long query exceeded the
existing bounded reader; a resolver invocation counter was not a model HTTP
counter; unsorted synthetic replacement rows were correctly rejected. The
repaired test keeps the same constraints and sorts provider evidence.

Files: the played search and private rescheduling menu, new signed refresh
journeys, design/manifest E2E-333 (version 1.131, 333 IDs), contract and scoped
evidence/plan documents. No real carrier, mail or clinic activation is claimed.

PR #422 merged family 3 at `e58b1e342260fef372b5f573afaf142e7edec416`.
Its GitHub runs were queued at the normal locally authorized merge and later
failed before starting: check-run 112617087173 reports account billing/spending
limits. Runs 37567063961 (PR) and 37567060294 (push) supplied no test execution
evidence; no CI pass is claimed. Families 5–18 remain pending.

Refresh validation: focused seven-journey test passes (23880.481118 ms).
Related regression passes 18 tests (103974.988766 ms), before the final explicit
previous-selection guard. Final guard regression passes 12 tests
(33242.46397 ms):

```sh
node --test --test-concurrency=2 test/voice/retained-availability-refresh.test.ts test/cliniko/rescheduling-session.test.ts test/contract/scenario-manifest.test.ts
```

Final `npm run typecheck`, `git diff --check` and patient-data canary scan pass.
Exact commands, scope and source hashes are in
`eval/baselines/second-call-batch-refresh-final-v1.json`.
