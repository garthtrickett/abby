# Shared budget storage readiness

This gap3/R23 component refuses a new standalone voice owner when its required
shared Cliniko budget storage is unavailable or incompatible. It does not
establish clinic admission, provider readiness, available quota or whole-call
completion. Existing default patient admission remains unproven/disabled.

## Observed compatibility before admission

`PostgresClinikoRequestBudget.schemaCompatible()` reads one bounded PostgreSQL
catalog snapshot. The private contract describes the two shared-budget tables
from migrations020 and048: actual relation/schema, columns and types,
nullability/defaults, primary/foreign/check constraints, and the enabled
legacy-worker hold trigger with its selected function language, privilege mode
and body hash. A missing, renamed or incompatible object refuses. Unrelated
tables and account data are outside this read.

The check reads no account/reservation row and does not claim quota, reserve
capacity, create a table, run a migration or alter data. Its result is an
observation of these declared schema properties, not a full database integrity
or access-control attestation. Other storage owners retain their contracts.
A new supported budget schema needs a reviewed contract update and current
qualification; arbitrary provider/database versions are not auto-approved.

The normal standalone factory checks before exposing its server. It rechecks
for an authenticated, otherwise admitted webhook and again before constructing
a new stream owner. A mismatch returns the existing storage failure at startup,
503/Unavailable for a new webhook, or refusal of the later stream. A previously
valid webhook is not authority to bypass a later incompatible schema.

The existing bounded-health owner limits a waiting caller to1500ms and shares
one in-flight schema probe. A timeout remains unavailable; another request
does not start another probe while it is pending. This is no cancellation or
completion claim about an underlying database query. A repaired compatible
schema can support a fresh new call without replaying a denied admission.

The guard does not terminate an existing active call or rewrite a known
clinical result. If storage changes after admission, each clinical/native
operation still needs its normal budget, authority and result evidence.
The point-in-time schema check cannot lock a schema or provider state for the
whole call. A database ping or `/healthz` response alone is not this check and
never establishes clinic readiness.

## Current local evidence

On unchanged delivered337, the same two503-contract controls fail: after a
healthy signed voice baseline and a successful SELECT1, renaming the required
budget table or timestamp column still issues Connect/abbyBinding. The corrected
source passes both. The initial200-fallback expectation was wrong for the
existing admission contract; its separate failed witness remains preserved.

The earlier combined27 checks pass with zero skips/cancellations:13 new
source-loaded signed HTTP/WSS/SQL controls, two new actual compiled startup
cases and12 preserved budget, profile, voice-service and bounded-health checks.
They cover table/column/type/default/constraint/hold-trigger drift, an earlier
webhook followed by a changed-schema stream, repair, an existing connected
call, unchanged account/reservation rows and bounded concurrent refusal.
The compiled runner first starts successfully, then refuses the changed schema
before opening a listener, with fixed sanitized output. These are synthetic
remote services and isolated local PostgreSQL, not real clinic/carrier tests.

Whole strict TypeScript and serving emission pass with727 outputs. Only the
standalone server and concrete budget outputs change; the new schema checker
is added and the other724 parent outputs remain exact. The later nonemitted
startup driver passes fresh whole strict without changing those727 bytes.
Initial source13 is included in27 and is not added again. The final current
cohort passes68/68, zero skips/cancellations, including those controls, preserved
operational E2E-176 failures and the product-facts/scenario contracts. Fresh
whole strict passes again with all727 serving artifacts unchanged. These68
include nested tests; they are not68 distinct end-to-end scenarios.

## Fresh work and deploying-host observation

The existing independent queue worker returns queueKnown only after its awaited
complete current scan, current approval checks and known transport outcomes.
Its compiled one-shot command exits0 for that result,2 for queueUnavailable and1
for other failure. Rendering its persistent timer and210-second service bound
does not prove that an owner installed it or detects missed/stopped runs.
The [deploying-host contract](../deploy/voice/CLINIKO_QUEUE_MONITOR.md#independent-timer)
requires a separate infrastructure channel for failed units and missing/late
polls. No actual channel, recipient or duty/backup escalation is established by
this schema cohort. Boot, process presence and receiver acceptance cannot
satisfy that acceptance; no additional daemon is introduced here.

## Independent completion coverage remains limited

R01 requires evaluating calls lost before application admission using an
independently authorized inventory. The existing liveness monitor enumerates
known ledger admissions/sessions. Operational counters keep fixed totals and
seven daily buckets; the native queue monitor observes pending/overdue clinic
reviews. The outbound closure reader inspects one independently captured
original and its children. None establishes all-carrier-call completeness.

In particular, one admitted-and-ended call and that same application history
plus a carrier call never admitted by Abby have identical application totals.
That is an inference from the stored interfaces, not a new executed provider
observation. No sufficient approved whole-inventory source is established by
this repository review. A native queueKnown result, database ping, call-ended
counter or selected root closure cannot close that coverage gap or prove that
an uncertain appointment action did not reach the provider.

Retain the [R01 source/acceptance requirements](KAREN_TO_ABBY_REUSE_AUDIT.md#r01-independently-detect-calls-missing-their-completion-path).
If a source is selected, qualify its tenant/profile/window completeness, late
completion suppression, duplicate/killed notifier and possibly-sent notice
behavior under current grants. No private durable call ledger, retained matching
identifier, patient-specific queue or new provider query is added here.

This component remains local pending review, actual current-parent
integration, its own CI and normal delivery. It completes no entire gap or
roadmap. Clinic/operator/source/restore/acoustic acceptance, live provider
traffic, deployment and default activation retain their separate gates.

## Actual normal-parent integration, 22 October 2026

The original68/727 proof above retains its delivered337 inputs. PR587 normally
merged asc3af48c after all eight own checks/raw logs passed; its actual-main
checks remain separate. This schema component imports that actual normal tree,
retaining its six owning source/test files exactly. Existing callbacks424/425
and extended176 are all retained under manifest1.248/425. Original727 outputs
were independently hash-copied before import. Fresh combined source/types/
serving/SQL/metadata qualification, review and this component’s own delivery
remain required; pending callback-memo PR588 is not silently included.

## Current actual-parent qualification

On local50f0157 with actual normal parentc3af48c, whole strict TypeScript and
serving emission pass1792704451137 in4m13s at1785651200B/2GiB. The741 outputs
add the private checker and change only server/budget from the740 parent; the
other738 parent outputs remain exact. All three schema-owner outputs equal
the preserved originally qualified bytes. Current metadata passes2/2 in
1792704488809. The complete current mixed cohort passes68/68, zero failure,
skip or cancellation, in1792704804999/4m42s: source-loaded signed schema, actual
compiled startup, preserved budget/voice/storage failures and facts/scenarios.
Node383729664B/512MiB plus owned PostgreSQL254881792B/512MiB, CPU100% each,
Swap0/allOOM-high-max0; database cleaned and paired waits reaped. Counts include
nested/overlapping tests and are not summed with the prior68 or parent cohorts.

This fresh proof qualifies this actual-parent component, not all425 scenarios
or a full regression. Pending memo PR588 and real clinic/operator/provider/
acoustic/retention/restore acceptance stay separate. A later actual normal
parent must be explicitly integrated and any changed inputs requalified before
this component’s own publication/delivery.

## Transaction ownership regression

Five additional R24 storage-owner cases use real disposable PostgreSQL and a
single-connection Kysely pool: early budget denial, an application exception
after transactional cleanup, failed statement, failed deferred commit and a
caller-owned outer transaction. A separate backend observes the next borrower's
autocommit write before a stale rollback; that write remains committed. The
nested case also proves that the budget cannot commit its caller's unrelated
work, and failed claims expose only the fixed unavailable diagnostic.

The targeted run passes12/12: these five cases plus seven preserved budget
controls. The earlier68 already includes those seven; the two runs are not
added into a new combined cohort. Whole strict TypeScript passes for the new
source-loaded driver, and all741 qualified serving artifacts remain unchanged.
No production transaction implementation, migration or pool monkeypatch was
introduced. The initial application-exception witness failed during fixture
setup because the legacy hold trigger rejected its invalid bigint; the corrected
fixture uses a PostgreSQL-valid integer outside JavaScript's safe range, which
the existing application guard rejects inside its transaction. The original
11/12 result is retained separately.

This is targeted evidence for the concrete shared-budget owner under
[R24](KAREN_TO_ABBY_REUSE_AUDIT.md#r24-protect-database-transaction-ownership),
not qualification of every storage adapter, a new voice scenario, the complete
regression or clinic activation. Other transaction owners retain their own
required evidence.
