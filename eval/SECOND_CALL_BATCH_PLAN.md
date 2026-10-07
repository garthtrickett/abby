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
| 4 | Vanished slots with retained caller constraints | Implemented; E2E-333 passes seven signed synthetic journeys; merged in PR #423; local checks passed |
| 5 | Follow-ups after a confirmed action, including canceling the old moved appointment | Implemented; E2E-334 passes eight signed synthetic journeys; merged in PR #424; local checks passed |
| 6 | Partial menu repetition and incremental navigation | Implemented; E2E-335 passes seventeen signed synthetic journeys; merged in PR #425; local checks passed |
| 7 | Compound weekday, time and date constraints | Implemented; E2E-336 passes thirteen signed synthetic journeys; merged in PR #426; local checks passed |
| 8 | Relative and source-relative dates and times | Merged PR #427; nineteen signed relative-date journeys |
| 9 | Staff message additions and corrections saved in Cliniko | Merged PR #428; twenty-one signed message journeys |
| 10 | Shared phones and changing patient identity | Implemented; E2E-339 passes seventeen signed journeys; publication pending |
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

PR #423 merged family 4 at `40221d2c34f289dc02dfb53c1e4f482a8aca234b`. Its queued GitHub runs later failed before starting: check-run 112620546452 cites account billing/spending limits. Runs 37568161891 (PR) and 37568157811 (push) supplied no test execution evidence. No CI pass is claimed.

## Post-action follow-ups: E2E-334

A bounded complete request to cancel the old/original/previous appointment now
selects a receipt explanation. A committed move explains that the source was
moved and the replacement was not canceled. The explanation reads the actual
call action kind/status; caller wording cannot establish a successful move.
Unknown actions retain their unknown receipt and clinic-contact path, while
unsent or absent actions require a fresh target check. No second write, model
prompt change, notification delivery or saved patient context is introduced.

The corrected before observation found classifier HTTP on “cancel my old
appointment” and generic wording on “cancel my original appointment.” The
initial move fixture expected the booking fixture's time, so it failed before
three follow-ups and is separately qualified. Existing confirmed-booking
reversals and email-proof questions passed their direct baseline controls.

Files: core clarification/reason, bounded appointment language and trusted
intent mapping, the new voice journeys, design/manifest E2E-334 (version 1.132,
334 IDs), contract and evidence/plan documents. Eight signed journeys inspect
owned final transcripts, actual POST/PATCH payloads, receipt/effect preservation,
model HTTP and a clean durable PostgreSQL patient-data scan. Additional guard
checks reject negation, quotation, mixed changes and guessed move status.

Focused eight-journey test: 1 pass / 0 fail (37285.551655 ms). Final related
regression: 7 pass / 0 fail (61085.103342 ms). Its invocation included an incorrect
nonexistent appointment-change test filename; Node did not execute that path.
The actual guard was then run separately, with 1 pass / 0 fail
(23983.154713 ms):

```sh
node --test --test-concurrency=2 test/voice/post-action-followups.test.ts test/voice/notification-outcome-query.test.ts test/voice/appointment-change-language.test.ts test/voice/final-negative-corrections.test.ts test/contract/scenario-manifest.test.ts
node --test test/voice/appointment-change-intent.test.ts
```

The one-possible-send policy still requires the caller to contact the clinic
for a further change after an action was sent. Dated old-appointment references
use the existing generic sent-action boundary; only explicit old/original/
previous wording receives the new source/replacement explanation. No real
carrier, clinic activation, email or new real-model pass is claimed. Families
6–18 remain pending.

Final `npm run typecheck`, `git diff --check` and patient-data canary scan pass. Exact source hashes and validation scope are in `eval/baselines/second-call-batch-followups-final-v1.json`.

PR #424 merged family 5 at `d7527d3a639c95ac5ed813b75bd7916bd9d9738e`. GitHub runs 37569142323 (PR) and 37569138438 (push) failed before starting; check-run 112623596246 reports account billing/spending limits. No CI pass is claimed.

## Played menu navigation: E2E-335

Complete repetition questions now derive fresh reads from an actually played
menu: all options, an offered weekday/date, or a numbered option. They never
propose a choice. A later/next question with one reference offer reads later
starts on that offer's actual clinic date. Multiple references or a missing day
clarify without model guesses or provider search. Unplayed menus and sent
receipts retain their existing boundaries.

A one-minute filter for repeating a particular option is temporary display
state. The search owner keeps the original caller window separately, and only
the exact incoming read turn may inherit it after a successful fresh menu read.
Thus a later question can leave that display filter while retaining “before
10 AM.” Failed, canceled or unrelated reads cannot inherit it. The host still
owns practitioner/location authority, proof, offer revalidation and one-send
policy. No selection command or write interface is expanded.

The thirteen-journey baseline reached owned final requests but all triggered
classifier HTTP. It failed at that assertion, so it does not establish later
read/write/privacy outcomes. Initial focus: 1 pass / 0 fail (22885.817974 ms).
Expanded final focus: 3 pass / 0 fail (25558.3078 ms), seventeen signed journeys,
negation/quotation/hidden-second guards and the manifest contract:

```sh
node --test --test-concurrency=2 test/voice/played-menu-navigation.test.ts test/contract/scenario-manifest.test.ts
```

Files: the bounded navigation module, played search owner and its existing
call/resolver seam; signed voice journeys; design/manifest E2E-335 (version
1.133, 335 IDs), contract and scoped evidence/plan documents. Missing or changed
provider times, denied proof and interrupted repeat playback cannot restore a
proposal. Fresh exact selection and separately played confirmation precede one
inspected POST/PATCH. PostgreSQL patient-data canaries remain empty.

The module recognizes bounded complete questions, not arbitrary speech. Later
navigation stays on the displayed date; it neither expands the date horizon nor
switches practitioners. General compound constraints and relative dates remain
families 7 and 8. No real carrier, mail, clinic activation or new real-model pass
is claimed. Families 7–18 remain pending.

Navigation regression: 9 pass / 0 fail (104324.845203 ms):

```sh
node --test --test-concurrency=2 test/voice/played-menu-navigation.test.ts test/voice/booking-search-windows.test.ts test/voice/retained-availability-refresh.test.ts test/voice/stale-menu-recovery.test.ts test/voice/dated-window-corrections.test.ts test/contract/scenario-manifest.test.ts
```

Final `npm run typecheck`, `git diff --check` and patient-data canary scan pass.
Exact source hashes and scope are in `eval/baselines/second-call-batch-navigation-final-v1.json`.


PR #425 merged family 6 at `69982b2b4d90599d0706b3b575180b612cee0e75`.
Runs 37570171134 (PR) and 37570163741 (push) failed before test execution;
check-run 112626782594 reports the account billing/spending limit. Normal merge
used the operator's existing local-validation authorization. No CI pass is claimed.

## Compound constraints: E2E-336

The search window now accepts bounded alternatives. Each clause combines its
weekday, explicit date and clock fields; clauses are alternatives. Clinic-local
filtering precedes the three-option limit, and fresh provider evidence must echo
the exact constraints. Nested inputs are copied before asynchronous reads. Menu
navigation intersects every branch with its display bound instead of dropping
weekday/date limits or making a one-minute display bucket sticky.

The baseline reached owned final speech but either clarified without another
availability read or triggered classifier HTTP. It failed before later mutation
and privacy assertions. The first implementation also clarified: punctuation
normalization left a trailing space, preventing removal of “please.” A read-only
parser probe diagnosed this; trimming before suffix removal fixed it. These
failures are qualified in the scoped evidence rather than reported as successful
clinical journeys.

Thirteen final signed synthetic journeys cover clock alternatives, weekday
alternatives, excluded Fridays, explicit date alternatives, shared and per-date
clock limits and per-weekday morning/afternoon bands, rescheduling, refresh, incremental navigation, unplayed menus,
contradictory bounds and unknown alternatives. Actual classifier HTTP, provider
queries, POST/PATCH payloads, private patient/source binding, played confirmation,
receipts and PostgreSQL canaries are inspected. Guard tests exercise invalid
nested constraints, input mutation, strict read echoes and clinic-local matching.
The related legacy windows, corrections, refresh, navigation and rescheduling
session gates pass: 20 tests, 0 failures (131263.306495 ms).

```sh
node --test --test-concurrency=2 test/voice/compound-booking-constraints.test.ts test/voice/booking-search-windows.test.ts test/voice/retained-availability-refresh.test.ts test/voice/played-menu-navigation.test.ts test/voice/dated-window-corrections.test.ts test/cliniko/rescheduling-session.test.ts test/contract/scenario-manifest.test.ts
```

Files: the core search-window contract, bounded compound parser, existing played
search, native booking/rescheduling read checks and host window capture,
navigation intersection, signed voice tests, design/manifest E2E-336 (version
1.134, 336 IDs), contract and scoped evidence documents. The original corpus is
unchanged. This is a complete bounded grammar: unknown alternatives clarify;
explicit dates span at most seven inclusive calendar days; weekday/clock-only
constraints use played date context. Existing half-open clock bounds, private
proof, provider/service authority, horizon, fresh confirmation and one possible
send are preserved. No real carrier, mail, clinic activation or new real-model
pass is claimed. Families 8–18 remain pending.

Final word-clock and weekday-band focus passes 3 tests / 0 failures, thirteen
signed journeys (33046.139026 ms):

```sh
node --test --test-concurrency=2 test/voice/compound-booking-constraints.test.ts test/contract/scenario-manifest.test.ts
```

The earlier 20-test regression precedes that bounded parser extension. Its core
compound contract, private capture, read echo and intersection changes are the
same. The added band's first test run correctly selected Monday morning but its
new expected-payload expression defaulted to Thursday; only that expectation was
corrected. The initial typecheck found two scalar-window accesses in the existing
conversation evaluator. Explicit legacy-variant narrowing preserves their
original criteria; no assertion is removed or relaxed. Both diagnostics are
qualified in the scoped evidence.

The existing agent input schema also allowed only scalar clocks. It now declares
bounded weekday/date/clock clauses for both existing read capabilities; no write
capability changes. Final focus passes 4 tests / 0 failures (24895.813395 ms),
thirteen signed journeys plus actual native booking and move reads. A host that
drops an OR branch cannot publish a menu through either native seam. The first
read-only schema probe omitted the required turn timestamp and is qualified;
a corrected complete command rejects the legacy window schema and accepts the
new schema. Final source hashes include the native capability catalogue.

Final `npm run typecheck`, `git diff --check` and signed PostgreSQL canary scans pass. Exact final source hashes and the qualified regression/focus scope are in `eval/baselines/second-call-batch-compound-final-v1.json`.


PR #426 merged family 7 at `0dc2c94990f34757427d608ed03ef9d5c76c08c9`.
The exact published head was `3d585d980b65f093d63ccd3995445e471aafad9d`.
GitHub PR run 37572328386 failed before starting; check-run 112633498402
reports account billing/spending limits. Push run 37572313757 was queued at the
normal local-authorized merge and later failed before test execution. No CI pass is claimed.


## Relative calendars and selected sources: E2E-337

A bounded calendar parser now derives next-week, one/two-week, calendar-month,
weekday and literal month/day/ISO reads from the clinic's date. A weekday stated
with a date must agree. Invalid/past dates, month overflow and unknown qualifiers
clarify rather than selecting an old option or dropping part of the request.
Next week is the following Monday through Sunday; next weekday belongs to that
week; plain weekday is the next occurrence. A month uses the corresponding
calendar day, without clamping or guessing a different year.

The protected move owner captures only the actual selected appointment's time,
zone, expiry and selection turn. Its played receipt is required for “same time
next week,” “same time on” an ISO date and a thirty-minute same-day shift. These
are clinic-calendar and local-clock calculations, followed by the ordinary fresh
Cliniko source/offer checks. Source facts stay transient and never enter model
context. No patient grant, reference or previous-call claim can supply them.
An unsent corrected move needs fresh offers, exact selection and a new separately
played confirmation. Sent actions keep their actual outcome and cannot send again.

The sixteen-journey baseline failed because each request triggered classifier
HTTP; it establishes no later mutation/privacy verdict. Initial focus correctly
stopped the month-away case at the approved 30-day clinic horizon. That test's
expectation was corrected to assert the boundary and no search, preserving policy.
The seventeen-journey related regression passed twelve tests (151901.847577 ms):

```sh
node --test --test-concurrency=2 test/voice/relative-booking-dates.test.ts test/voice/dated-window-corrections.test.ts test/voice/booking-search-windows.test.ts test/voice/compound-booking-constraints.test.ts test/voice/retained-availability-refresh.test.ts test/voice/played-menu-navigation.test.ts
```

It predates the final canceled-source and literal-date additions. Final focus
passes six tests, nineteen signed journeys (61132.299988 ms), including the final
compound/parser guard and manifest:

```sh
node --test --test-concurrency=2 test/voice/relative-booking-dates.test.ts test/voice/compound-booking-constraints.test.ts test/contract/scenario-manifest.test.ts
```

Actual provider query dates, POST/PATCH payloads, patient/source binding, receipts,
model HTTP bodies and PostgreSQL canaries are inspected. Files: the bounded
relative parser, played-search owner, call-flow selected-target seam, signed
journeys, design/manifest E2E-337 (version 1.135, 337 IDs), contract and scoped
baseline/evidence documents. The original corpus remains unchanged. No real
carrier, mail, clinic activation or new real-model pass is claimed. Families
9–18 remain pending. Exact source hashes and qualified run scope are retained in
`eval/baselines/second-call-batch-relative-final-v1.json`.

The initial final typecheck rejected an optional window spread that could carry
`undefined` under exact optional properties. Narrowed the field before building
the range, then reran nineteen signed relative-date journeys plus calendar and
manifest guards: 3 pass, 0 fail, 46441.042885 ms. No date/window semantics changed.

Final `npm run typecheck` passed (1m43s). Source hashes, real-call privacy scan
and `git diff --check` passed on the final source.

PR #427 merged family 8 at `8feafabf9f04412ec0d5938e2adf2e7edd65e10f`. Runs 37574089154 (PR) and 37574075253 (push) failed before execution; check-run 112638985305 reports billing/spending limits. Local checks passed and normal merge followed the operator authorization. No CI pass is claimed.

## Family 9: exact caller messages in Cliniko

The previous staff request saved its subject/person, but had no private literal
message field. E2E-338 now owns a transient draft before classifier inference.
After independent staff verification, a caller can give, add or replace bounded
details. Only a literal send request after a played notice captures the final
content for the existing Cliniko recall writer. The prepared request rechecks
conversation/source turn IDs, current patient permission, approval and summary
limits before one possible send. No content enters model bodies or durable Abby
state. Generic callback wording keeps its previous behavior.

A late addition cannot append to an earlier request or produce a second send.
The actual saved/unknown status is stated, with clinic-contact recovery. Requested
email delivery and callback windows remain caller preferences; saving them is
not a promise of staff availability or an email action.

Validation:

```sh
node --test --test-concurrency=2 test/voice/staff-message-corrections.test.ts test/voice/cliniko-staff-request.test.ts test/voice/staff-request-purpose.test.ts test/text/staff-request-purpose.test.ts test/text/staff-task.test.ts test/contract/scenario-manifest.test.ts
```

15 pass, 0 fail, 56310.705521 ms, including twenty new signed message journeys;
before narrowing detailed-message send interception to an active draft.

```sh
node --test --test-concurrency=2 test/voice/staff-message-corrections.test.ts test/voice/cliniko-staff-request.test.ts test/contract/scenario-manifest.test.ts
```

Final source: 4 pass, 0 fail, 46950.702157 ms. Twenty-one E2E-338 signed journeys
include exact additions/replacements, natural email/callback preferences, generic
request compatibility, explicit consent, unplayed/changed/expired/denied gates,
unknown outcomes and late additions. Model HTTP, exact patient/queue notes and
PostgreSQL canaries are checked independently. Manifest 1.136, 338 IDs.

Bounded syntax and 350-character messages; full summaries still obey the writer
limit. Replacement means replacing the complete message. No real carrier, clinic
activation or new real-model pass. Families 10–18 remain open. Qualified baseline,
failures, final hashes and results: `eval/baselines/second-call-batch-message-final-v1.json`.

Final `npm run typecheck` passed (1m39s). Exact source hashes, real-call privacy
scan and `git diff --check` passed on the final source.

PR #428 merged family 9 at `3720d4e5fac3fa2b9da53fa02dd41a6f8dfda4c2`. Runs 37575187512 (PR) and 37575168566 (push) were queued at merge and subsequently failed before execution; check-run 112642382649 reports billing/spending limits. Local checks passed. No CI pass is claimed.

## Family 10: patient changes cannot inherit old authority

The bounded identity recognizer now catches explicit name/patient changes,
third-party caller roles and borrowed/shared-number ownership before classifier
inference and private message capture. Each declaration uses the existing
monotonic patient denial. It does not switch patients or assume proxy consent.
Private owners/grants are disposed, unsent proposals cancel and earlier committed,
unknown or staff receipts remain in SAM. Clinic contact is the supported recovery.

Baseline: fourteen signed journeys failed the immediate no-inference or denial
assertion; later grant/write/privacy assertions were not reached. One negative
literal guard passed. Focus: 2 pass, 0 fail, 23364.560372 ms.

```sh
node --test --test-concurrency=2 test/voice/patient-change-authority.test.ts test/voice/caller-identity-denial.test.ts test/voice/staff-message-corrections.test.ts test/contract/scenario-manifest.test.ts
```

Final source: 5 pass, 0 fail, 59866.755399 ms, including seventeen new signed
identity journeys, existing monotonic-denial regression and message-draft
regression. Provider reads, proof emails, POST/PATCH counts, prior receipts, old
code rejection, exact subsequent denial and durable PostgreSQL canaries are
checked. Manifest 1.137, 339 IDs.

Scope remains bounded explicit language. Ordinary introductions, quotations,
negations and unrelated medical statements do not trigger the new declarations.
No identity comparison, patient switching, proxy authorization or new private
lookup. Synthetic evidence only; no real carrier, clinic activation or new
real-model pass. Families 11–18 remain open. Exact source hashes and qualified
results: `eval/baselines/second-call-batch-patient-change-final-v1.json`.

Final `npm run typecheck` passed (1m55s). Source hashes, real-call privacy scan
and `git diff --check` passed on the final source.
