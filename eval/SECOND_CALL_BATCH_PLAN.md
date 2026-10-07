# Second call batch: implementation and evidence

The operator requested all eighteen scenario families from the conversation
assessment. Implementation followed the order below. Real transcripts, patient details
and recording links are excluded. The original 45-case corpus and its historical
evidence remain intact; new journeys use synthetic inputs and inspect actual
Cliniko mutation payloads and call receipts.

## Completion

All eighteen requested scenario families are implemented and merged through PRs
#421–#437. The final implementation is `54eee2d9a8a091a2e47b55dcf2dc8e7550ff762f`.
[Machine-readable completion evidence](baselines/second-call-batch-completion-v1.json)
records each merge and its local evidence. Final integration: 15 tests passed;
final typecheck passed. CI jobs failed before starting due to account payments
or spending limits; no CI pass or live activation is claimed. Unsupported
services retain truthful clinic-contact paths. Real mail, carrier activation and
Splose remain operator-deferred. Historical sections below retain the then-current
open-family and publication status; this table records final completion.

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
| 10 | Shared phones and changing patient identity | Merged PR #429; seventeen signed identity journeys |
| 11 | Bounded pauses, writing time and reopening after goodbye | Merged PR #430; fourteen signed pause/goodbye journeys |
| 12 | External appointment changes and previous-call claims | Merged PR #431; eighteen signed external-change journeys |
| 13 | Private intake spelling and field repairs | Merged PR #432; sixteen signed private-intake journeys |
| 14 | Payment, deposit, currency, refund and insurance evidence | Merged PR #433; thirty-two signed financial-evidence journeys |
| 15 | Clinical request boundaries and approved routing | Merged PR #434; twenty-four signed clinical-boundary journeys |
| 16 | Conflicting public facts and unusable arrival instructions | Merged PR #435; twenty-two signed arrival/public-fact journeys |
| 17 | Practitioner and service preferences, history and duration | Merged PR #436; twenty-one signed practitioner/service journeys |
| 18 | Home visits, classes, telehealth and practitioner changes | Merged PR #437; twenty-one signed special-service journeys |

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

PR #429 merged at `fd539c229cd1e78fcf1f4dea0d285568feb02e26`. Exact branch HEAD `8b643016965eec8a2995f00f428a1c2c8d22cde1`: Actions 37575996545 (pull_request) and 37575978861 (push) failed before execution. Job 112644912831 reports the account billing/spending limit. Normal local-check merge was operator-authorized; no CI pass is claimed.

## Caller waits and goodbye: E2E-340

The baseline eleven signed journeys failed the immediate notice or actual-model
HTTP assertion. Complete “please hold” matched the automated-announcement guard,
writing requests reached model fallback, and goodbye used normal inference.
Later timing, send and privacy assertions were not reached. Baseline: 0 pass,
1 fail, 15167.138406 ms.

Complete bounded control phrases now enter canonical fixed notices before
inference or private message capture. Two consecutive played pauses each permit
thirty seconds; the third uses the ordinary idle deadline. A played goodbye
permits five seconds for another caller request, then closes normally without
an idle retry. Qualified speech cancels the old deadline. Unplayed notices still
require playback evidence and use the existing playback failure deadline.

These controls grant no patient permission or mutation consent. Unsent proposals
are canceled and require fresh options, proposal and separate affirmation. Prior
known or unknown mutation receipts retain their one-send fence. A transient
message draft can retain its exact content across accepted controls only when
the preceding notice was played and revisions match; later explicit send still
requires the new control notice to be played and current independent permission.
No new durable patient field, write path, dependency or clinic policy.

First corrected focus: 9 pass, 0 fail, 30194.003014 ms (eleven signed journeys
and manual timer evidence, before three final fence journeys). Related regression
on the final production source: 13 pass, 1 fail, 92778.900087 ms. The failure
was the new test expecting a transport error after affirming a canceled proposal;
the actual reply was a safe clarification. The test now asserts no mutation and
all proposals canceled. Production code did not change after that regression.
The related automated-announcement, pending-read/silence, message-draft and
identity-denial tests passed in that run.

Final focus before the explicit notice-kind narrowing: 10 pass, 0 fail,
27865.517709 ms, fourteen signed journeys. Initial typecheck failed at two
`Presentation.approvedText` accesses because a transfer has no text. Both now
require `kind === "notice"` before comparison; timing and consent behavior were
not changed. A focus and typecheck on that exact source follow.

Exact notice-kind source focus: 10 pass, 0 fail, 25750.760539 ms; all fourteen signed journeys, timing/negative guards and manifest contract pass.

Final `npm run typecheck` passed (1m10s). Exact source hashes, scoped privacy scan and `git diff --check` pass. No real-model or CI success is claimed. Families 12–18 remain open.

PR #430 merged at `a8eaf820d5ca9d458b8afd478813510ac4b26980` on 2026-10-07 05:43:35 UTC. Exact branch HEAD `915f24e4593469b02fd76dc3f9b662620629b047`: Actions 37577722942 (pull_request) and 37577707521 (push) were queued at merge and still queued at the last check. No CI pass is claimed. Normal local-check merge was operator-authorized.

## External and previous-call changes: E2E-341

Complete literal claims about an appointment changed online, directly with a
provider, or on an earlier call cannot start default booking inference or
confirm a past outcome. A started online booking is also treated as unverified.
The existing negative request boundary clears unsent proposals, source/menu
owners, private message drafts and old proof. Known and unknown actual sends
keep their earlier receipt and cannot repeat. The guard precedes private draft
capture; explicitly prefixed message content continues as private content.

Current appointment checks require a separately explicit enquiry and fresh
read-specific verification, policy and Cliniko evidence. Signed evidence shows
current records, empty results, changed clocks, denied permission and provider
failure after an earlier played menu; no past claim selects or mutates a future
target. No durable appointments or previous-call state, new write path or
positive patient authority.

Baseline: 1 pass, 1 fail, 14058.629167 ms; all seventeen signed journeys failed
immediate actual-model-HTTP assertions. Later assertions were not reached.
First focus: 1 pass, 1 fail, 15964.712191 ms; only the new unknown-outcome
wording assertion was wrong and was corrected to the existing exact receipt.
Related regression: 9 pass, 0 fail, 52747.450004 ms, before the final draft
precedence refinement and eighteenth signed journey.

```sh
node --test --test-concurrency=2 test/voice/external-appointment-claims.test.ts test/voice/appointment-enquiries.test.ts test/voice/booking-request-boundaries.test.ts test/text/request-boundary.test.ts test/contract/scenario-manifest.test.ts
node --test --test-concurrency=2 test/voice/external-appointment-claims.test.ts test/voice/staff-message-corrections.test.ts test/contract/scenario-manifest.test.ts
```

Final source focus: 4 pass, 0 fail, 36652.523689 ms; eighteen signed claims and
existing private-message regression. Manifest 1.139, 341 IDs. Exact provider
read/write counts, fresh mail proof, code revocation, earlier receipts, current
clock/empty/failure replies and durable PostgreSQL canaries are checked.
Scoped evidence: `eval/baselines/second-call-batch-external-final-v1.json`.
No model prompt revision, general past-call understanding, live mail delivery,
real carrier or clinic activation. Families 13–18 remain open.

Final `npm run typecheck` passed (1m52s). Exact source hashes, synthetic privacy scan and `git diff --check` passed. Publication follows the operator-authorized local-check merge policy; no CI pass is claimed.

PR #431 merged at `e736fc62d456b3ae6d12bee6e8884f04d61c6d9a` on 2026-10-07 05:57:00 UTC. Exact branch HEAD `05c27d9f4a3439514bf5396b9a959f55fa690d64`: Actions 37578855386 (pull_request) and 37578842843 (push) were queued at merge. No CI pass claimed; normal local-check merge was operator-authorized.

## Private spelling and field repairs: E2E-342

The private field parser now decodes explicit single letters and complete NATO
runs, validates letter/phonetic pairs, and accepts calendar-valid day/month/full
year numeric dates without guessing a century. Literal name punctuation and
compact email punctuation are preserved. Email fragments remain in private
call memory; continuation is explicit, full replacement drops the old fragment,
and invalid replacement clears it before retry. Waits and fragments use the
existing three-attempt limit. No ordinary caller/model context receives fields.

Exact private readback still must play before OTP mail; keypad proof and separate
saving confirmation precede one patient POST. Unplayed readback sends no mail;
a lost patient response remains unknown and cannot retry. Provider payload and
durable PostgreSQL canaries are independently checked. Existing adult self-only
intake policy and four fields remain; addresses and post-save field edits are
outside this change.

Baseline: 0 pass, 1 fail, 11589.74251 ms; fifteen signed journeys. The evidence
qualifies the repeated-Yes test expectation error separately from parsing gaps.
Initial focus: 0 pass, 1 fail, 12126.731783 ms; only email NATO readback failed.
Corrected focus: 2 pass, 0 fail, 19352.926632 ms, before final fragment-reset
refinement and sixteenth journey. Final regression on that source: 27 pass,
0 fail, 46572.63616 ms.

```sh
node --test --test-concurrency=2 test/voice/private-intake-spelling.test.ts test/voice/cliniko-workflow-call.test.ts test/cliniko/caller-mediated-intake.test.ts test/contract/scenario-manifest.test.ts
```

Manifest 1.140, 342 IDs. No real model, carrier, mail or clinic activation claim.
Families 14–18 remain open. Typecheck follows.

PR #431 Actions 37578855386 and 37578842843 completed failure before steps ran;
check 112653735567 reports failed account payments/spending limit. This is no CI
validation result and no CI pass is claimed. Repository billing was not changed.

Initial `npm run typecheck` failed (2m01s) at two RegExpExecArray tuple casts. Explicit non-null capture reads replace the casts without date behavior changes; exact-source signed focus and typecheck follow. The 27-test regression above predates that equivalent narrowing.

Exact capture-read source: `node --test --test-concurrency=2 test/voice/private-intake-spelling.test.ts test/contract/scenario-manifest.test.ts` passed (3 pass, 0 fail, 15716.517792 ms), including all sixteen signed journeys.

Final `npm run typecheck` passed (1m22s). Exact source hashes, synthetic privacy scan and `git diff --check` passed. No CI pass is claimed.

PR #432 merged at `c59fe304732de0b46469de8104161a3285cd682a` on 2026-10-07 06:09:21 UTC. Exact branch HEAD `73349d4b691a95b6f405b2b65ac31bdd0983c76d`: Actions 37579965660 (pull_request) and 37579959705 (push) were queued at merge and at the last check. No CI pass claimed; normal local-check merge was operator-authorized.

## Financial evidence boundaries: E2E-343

Complete bounded current payment/link failure, refund, coverage and reservation
questions now select fixed negative notices before classification. No caller
statement or appointment receipt establishes payment, a refund, policy coverage
or a paid reservation. Pending proposals are canceled; known and unknown actual
appointment sends retain their exact status and one-send fence. Public price
facts remain pinned approved text and retain GBP, EUR and NZD exactly.

Explicit card-number disclosure cannot reach model HTTP or private Cliniko note
content. Other active private payment-update messages preserve existing question
and explicit-send proof fences; the only read on that question is the exact
existing verified-patient refresh. No financial operation or extra send occurs.
International caller/link requests cannot trigger a promised payment link.

Baseline: 0 pass, 1 fail, 21802.632665 ms. Twenty journeys failed immediate
no-classifier assertions; five approved-price cases passed. The denied setup
failed before its financial question and was corrected to an existing literal
cue. Initial focus: 0 pass, 1 fail, 21789.226072 ms, only that setup failure.
Expanded focus: 1 pass, 1 fail, 45688.671858 ms; only the new staff question's
zero-read expectation was wrong. The corrected assertion requires the exact
verified-patient GET, while forbidding payment work and extra sends. Production
was unchanged after that run. Corrected focus: 2 pass, 0 fail, 17970.099849 ms.

Final regression on the published source: 8 pass, 0 fail, 92995.82723 ms,
including thirty-two new signed journeys, approved-price, private-message and
post-action receipt regressions.

```sh
node --test --test-concurrency=2 test/voice/financial-evidence-boundaries.test.ts test/voice/public-service-guidance.test.ts test/voice/staff-message-corrections.test.ts test/voice/post-action-followups.test.ts test/contract/scenario-manifest.test.ts
```

Manifest 1.141, 343 IDs. No payment processor, card collection, coverage decision,
payment-link sender, automatic expiry/refund or payment-dependent reservation.
These require clinic handling. No new patient authority, provider mutation path,
durable patient field, dependency or repository configuration change. No live
carrier/mail/clinic activation or new real-model pass. Families 15–18 remain open.
Typecheck follows.

Initial `npm run typecheck` failed (1m21s) because the test fixture union did not narrow the optional price fixture. An explicit typed price-fixture reference fixes the test without changing production. The eight-test regression predates that equivalent fixture narrowing; exact-source focus and final typecheck follow.

Exact typed-fixture source: `node --test --test-concurrency=2 test/voice/financial-evidence-boundaries.test.ts test/contract/scenario-manifest.test.ts` passed (3 pass, 0 fail, 15922.901713 ms), including all thirty-two signed journeys.

Final `npm run typecheck` passed (1m44s). Exact source hashes, synthetic privacy scan and `git diff --check` passed. No CI pass is claimed.

PR #433 merged at `1d9fef3687630709ca6126c9bcde6d3425021f46` on 2026-10-07 06:31:20 UTC. Exact branch HEAD `c9cf63d9ed19a02a8318e0d1789a2b1a5398785b`: Actions 37581572327 (pull_request) and 37581567399 (push) were queued at merge. No CI pass claimed; normal local-check merge was operator-authorized.

## Clinical suitability boundaries: E2E-344

Complete bounded clinical questions now select the existing medical-advice
boundary before classifier HTTP: treatment suitability, first-visit procedures,
medication changes, post-treatment concerns and NHS vaccine eligibility. Neither
caller symptoms nor approved general service text establishes a recommendation,
clinical clearance, vaccine entitlement or an appointment type. General treatment
listings read exact current approved descriptions; active private reports keep
existing fresh proof, question fencing and a separate explicit Cliniko send.

Baseline: 0 pass, 2 fail, 13751.889725 ms. Nineteen journeys reached actual
classifier HTTP; later assertions were not reached. Four urgent script cases
and the private message case passed within the aggregate. An earlier import
failure (2125.225544 ms) provided no behavioral evidence and was corrected using
the existing publicServices export and services option before the baseline.
Initial focus: 1 pass, 1 fail, 11883.851315 ms. Only the missing-description
assertion expected different wording; it now checks the existing approved-source
unavailable notice. Production was unchanged after that run.

The new signed journeys inspect approved, missing, expired and foreign urgent
scripts, pending and actual known/unknown action status, denied identity, model
HTTP and native provider/mail counts, private note content and PostgreSQL
canaries. No symptom triage, diagnosis, inferred eligibility, promise of benefit,
new provider operation or durable patient field. Bounded complete phrases only;
other wording retains existing protected classification. Synthetic speech,
approvals, provider and mail do not establish live carrier, mail, clinic activation
or a new real-model pass. Families 16–18 remain open.

PR #433 Actions 37581572327 and 37581567399 failed before any steps ran.
Check 112662218208 reports failed account payments/spending limit; no CI
validation pass is claimed and repository billing was not changed.

Final regression: 9 pass, 0 fail, 93705.91493 ms, including twenty-four new signed journeys.

```sh
node --test --test-concurrency=2 test/voice/clinical-suitability-boundaries.test.ts test/voice/public-service-guidance.test.ts test/voice/urgent-conversation-routing.test.ts test/voice/staff-message-corrections.test.ts test/contract/scenario-manifest.test.ts
```

Manifest 1.142, 344 IDs. Typecheck follows.

Final `npm run typecheck` passed (1m19s). Exact source hashes, synthetic privacy scan and `git diff --check` passed. No CI pass is claimed.

PR #434 merged at `5c7183c0b6c61451c7c0730ce1a6d63eaac4b1f3` on 2026-10-07 06:38:07 UTC. Exact branch HEAD `5d93b43f2f41e2ad376880f5105ea905bd8c9e88`: Actions 37582572516 (pull_request) and 37582566669 (push) were queued at merge. No CI pass claimed; normal local-check merge was operator-authorized.

## Arrival and public fact boundaries: E2E-345

Reported locked doors, absent staff, unusable intercoms, roadworks and wheelchair
barriers select truthful negative access guidance before routine notification or
model booking guesses. Address/hour conflict reports cannot choose an invented
public fact. Independent private arrival messages keep literal content, fresh
proof, question fencing and a separate explicit Cliniko send.

Baseline: 0 pass, 1 fail, 12960.917918 ms. Twelve arrival journeys reached actual
classifier HTTP; the address/email conflict reached notification status instead.
Later assertions in those cases were not reached. Duplicate, changed, expired
and revoked source cases already spoke unavailable, then hit a test's overly broad
zero-internal-item assertion. Existing systemFailure/needsReview items are
transient receipts; no provider write or patient-message send occurred. Corrected
tests inspect those exact negative item kinds and use an actual private question
instead of a freeform statement that correctly replaced its draft.

Initial focus: 0 pass, 2 fail, 16374.222809 ms. Only the complete form "I arrived"
was missing; added alongside "I have arrived". Final regression: 8 pass, 0 fail,
49470.765494 ms, including twenty-two new signed journeys.

```sh
node --test --test-concurrency=2 test/voice/arrival-fact-boundaries.test.ts test/voice/clinic-faqs.test.ts test/voice/public-service-guidance.test.ts test/voice/staff-message-corrections.test.ts test/contract/scenario-manifest.test.ts
```

Manifest 1.143, 345 IDs. Complete bounded phrases only. No new patient authority,
provider operation, durable patient field, dependency or configuration change.
No promise of access, staff presence or transfer outcome. Competing, replaced,
expired and revoked sources fail closed; arbitrary contradictions inside a single
approved paragraph remain the operator's content responsibility. Original
45-case corpus unchanged; synthetic evidence is not live carrier/mail/clinic
activation or a new real-model pass. Families 17–18 remain open. Typecheck follows.

Final `npm run typecheck` passed (1m34s). Exact source hashes, synthetic privacy scan and `git diff --check` passed. No CI pass claimed. PR #434 Actions 37582572516/37582566669 failed before steps; check112665365165 reports account payments/spending limit.

PR #435 merged at `92cfd9eed518e4a1aa8d12f8318180238144ca15` on 2026-10-07 06:44:45 UTC. Exact branch HEAD `f7ed7d9e30340de7e5b98a2533555206bbd9f9f8`: Actions 37583198848 (pull_request) was queued and 37583193286 (push) completed failure at merge. No CI pass claimed; normal local-check merge was operator-authorized.

## Practitioner and service constraints: E2E-346

Complete unsupported gender, history, style, ranking, service and duration
requests now use negative existing notices before a classifier can guess a default
booking. No gender is inferred from a name, alias from spelling, previous provider
from familiarity, treatment style from a comparison or service from symptoms.
Exact independently approved names and any-practitioner search retain the existing
native cohort. Three new positive signed journeys inspect the exact practitioner,
location, type, approved spoken duration, final confirmation and one provider send.

Baseline: 0 pass, 1 fail, 18734.102289 ms. Fourteen journeys reached actual
classifier HTTP; later assertions were not reached. Seven cases passed within the
aggregate: canonical primary/alternate and any-practitioner sends, unknown alias,
private prior-practitioner message, existing male-name rejection and duration
boundary. Focus: 2 pass, 0 fail, 18238.523911 ms; twenty-one signed journeys.
Final regression: 8 pass, 0 fail, 76148.41755 ms.

```sh
node --test --test-concurrency=2 test/voice/preference-service-boundaries.test.ts test/voice/approved-booking-search.test.ts test/voice/appointment-change-intent.test.ts test/voice/public-service-guidance.test.ts test/contract/scenario-manifest.test.ts
```

Manifest 1.144, 346 IDs. No new catalogue metadata, gender/alias/history source,
clinical recommendation, duration/type switching, provider operation, positive
patient authority, durable patient field, dependency or repository configuration.
Complete bounded phrases only. Original 45-case corpus unchanged; synthetic
evidence is not live carrier/mail/clinic activation or a new real-model pass.
Family18 remains open. Typecheck follows.

PR #435 push Actions 37583193286 failed before steps. Check112667324644 reports
account payments/spending limit; no CI pass claimed.

Final `npm run typecheck` passed (2m03s). Exact source hashes, synthetic privacy scan and `git diff --check` passed. No CI pass claimed.

PR #436 merged at `78a65cbe76547ffe2a465931e9b59e60641f6e65` on 2026-10-07 06:52:16 UTC. Exact branch HEAD `7457fc76f40111c3f49117c340e8a2b80a30ddde`: Actions 37583899780 (pull_request) was queued and 37583893517 (push) completed failure at merge. No CI pass claimed; normal local-check merge was operator-authorized.

## Special-service boundaries: E2E-347

Explicit Pilates/mat/gym class and membership requests now use the existing group
boundary rather than individual bookings. Complete home-visit, visit-mode and
source-practitioner change requests receive truthful unsupported-service notices.
No class inventory, membership redemption, home-visit arrangement, telehealth/type
switch or cross-practitioner source change is implemented or inferred. Independently
verified private class-absence and home-visit messages can be sent to Cliniko after
a separate explicit confirmation; a message receipt is not a service reservation.

Baseline: 0 pass, 1 fail, 14972.928338 ms. Fifteen journeys reached actual classifier
HTTP; later assertions were not reached. Two requests reached existing ambiguous
change notices rather than an explicit service boundary. Four cases already passed:
exact native cancellation and same-practitioner movement with second source92
untouched, and independent private class/home-service messages. A generic synthetic
first-name class-absence fixture was renamed before final evidence; no real log
identifiers or recordings are retained.

Focus: 2 pass, 0 fail, 15027.996429 ms; twenty-one signed journeys. The positive
individual changes use exact source91, preserve approved type/duration and need
separate confirmation; repeated assent cannot send again. Pending proposals cancel,
while actual known and unknown earlier sends retain their exact state and send fence.

Manifest 1.145, 347 IDs. Complete bounded phrases only; no new positive patient
or provider authority, durable patient field, dependency or repository configuration.
Original 45-case corpus unchanged. Synthetic signed ingress/provider/mail/approval
is not live carrier/mail/clinic activation or a new real-model pass. Real mail,
carrier activation and Splose remain explicitly deferred by the operator.

PR #436 push Actions 37583893517 failed before steps. Check112669535161 reports
account payments/spending limit; no CI pass claimed.

Final integration regression: 15 pass, 0 fail, 96015.283096 ms. All five latest boundary families together, existing unsupported-request and post-action receipt regressions passed on final production source.

```sh
node --test --test-concurrency=2 test/voice/special-service-boundaries.test.ts test/voice/preference-service-boundaries.test.ts test/voice/arrival-fact-boundaries.test.ts test/voice/clinical-suitability-boundaries.test.ts test/voice/financial-evidence-boundaries.test.ts test/voice/booking-request-boundaries.test.ts test/voice/post-action-followups.test.ts test/contract/scenario-manifest.test.ts
```

Typecheck follows.

Final `npm run typecheck` passed (1m55s). Exact source hashes, synthetic privacy scan and `git diff --check` passed. The original corpus `eval/clinic-conversation-candidates-v1.json` is byte-identical to starting base `11c6e7236b17636c9bbdc9583f21c43259768de1`; SHA256 `2b537ef47b49a393c4916a43e0cbfc9e54f58a03daab6170b21ec3fa369e6e2c`. No CI pass claimed.

PR #437 merged at `54eee2d9a8a091a2e47b55dcf2dc8e7550ff762f` on 2026-10-07 07:02:39 UTC. Exact branch HEAD `07dad868fe2468b728c584d06260554ea79af13f`: Actions 37584891569 (pull_request) and 37584885520 (push) failed before any steps ran. Check112672663103 reports account payments/spending limit. No CI pass claimed; normal local-check merge was operator-authorized. All requested families are complete.
