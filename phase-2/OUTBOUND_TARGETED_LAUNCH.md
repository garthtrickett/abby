# Exact sick-day call launch

`ClinikoOutboundLaunchOwner` supports an explicitly configured sick-day call against one original native individual appointment. General follow-up retains its existing grant requirements; the default composition still refuses appointment-targeted work. This extends call preparation only. The finite scheduler now has a separately qualified explicit exact sick-day composition; protected callback cancellation, movement, booking and disclosure still require separate verified patient authority.

## Explicit composition

Configure `individualTarget.appointmentPolicyDigest` and supply a separate `OutboundTargetAuthority`. The owner composes the concrete `ClinikoOutboundAppointmentTarget` with its own exact request source, scope, business, credentials and physical Cliniko budget. Current native appointment-body and decoded-target grants remain independent from contact, audience, provider, producer/restore and launch grants. The new `approveAppointmentTarget` launch decision receives the exact original target, version digest and configured appointment-policy fingerprint. A read grant alone cannot supply that decision.

The clinic-approved campaign and native request must both specify `sickDay`. The request must already contain the exact appointment reference and digest. There is no nearest appointment, patient list, household or replacement-target fallback. Targeted follow-up requests remain unsupported by this extension. No sick-date/practitioner audience may be inferred; current independent clinic grants must approve that exact campaign and target.

## Fresh target at dispatch

Each preparation observes the pinned native target before the independent launch decisions, then rereads it after all other grant, contact, history and policy waits. The final provider dispatch fence runs preparation again. Changes to practitioner, appointment type, subject, business, raw timestamp precision, duration, cancellation or other bound status invalidate the request. Native IDs and timestamps do not select a replacement.

The appointment must remain unarchived, uncancelled, undeleted, neither arrived nor marked missed, and have a future start. The synchronous final fence checks its start time again after waits. The original target and policy binding remain stable throughout one invocation; captured authority methods cannot be replaced. The owner refuses on abort, deadline, denied current grants, changed evidence or insufficient quota. This is a fresh observation under acknowledged external-writer races, not atomic native compare-and-swap.

The same account-wide 180-request budget applies. Composition still requires an explicit reviewed total native cost for its actual authority profile; a synthetic 150-request profile is not a reservation or universal default. Independent possible-attempt acknowledgement precedes one provider invocation, using the existing v3 capacity/DNC context. Private target data stays in native records and volatile state. The provider still receives only opaque effect/allocation references, dialled number and approved profile. No patient proof, appointment data, private target digest or clinical action authority is passed to it.

Known exact provider acceptance survives later target-permission withdrawal. Unknown dispatch remains consumed and holds capacity. A cold process must inspect original native possible-attempt history, including closed/archived rows; local row loss, process death or a stale quota denial cannot justify another call.

## Remaining requirements

Separately qualified optional Twilio/Abby conversation, authenticated recovery, number-wide blocking and verified original-appointment clinical owners retain their own evidence and grants. This scheduler supplies none of that clinical or contact authority. A hosted Vapi adapter remains a separate future implementation. Actual clinic/producer/source/retention/restore/acoustic acceptance and inferred sick-practitioner/date audience generation remain unqualified. An approved generic greeting cannot disclose appointment details before verification; the existing rescheduling owner must preserve its original-span and independent destination checks.

Finite sick-day scheduling is explicit and bounded. No default outbound listener, live call, activation, new local patient store or schema is added; native pending-request grants do not authorize clinical callback actions. See [runtime responsibilities](OUTBOUND_RUNTIME.md), [outbound contract](OUTBOUND_SICK_DAY_CONTRACT.md) and [qualification evidence](EXECUTION_PROGRESS.md).
