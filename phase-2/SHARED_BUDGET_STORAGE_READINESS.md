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
