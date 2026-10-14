# Cliniko class passes and session tracking

Gap 10 includes membership/pass/credit handling. A complete caller workflow is
still unfinished. E405 supplies the native adapter; E406 connects explicit approved pass booking
to the ordinary caller host. Cancellation/movement and financial handling are
not complete, and real clinic activation remains unqualified.

## Provider contract

Cliniko [describes packages tracked with patient cases and optional account
credit](https://help.cliniko.com/en/articles/6477363-tracking-packages-with-patient-cases-and-account-credit).
The case's appointment counter and a patient's money are separate. A package
invoice may already have been paid without leaving account credit. A case name,
concession, remaining session count or channel verification cannot establish
payment, insurance coverage, a refund or a transferable membership.

The current [PatientCase schema and related attendee
collection](https://docs.api.cliniko.com/openapi/patient-case/patientcase) expose
the owning patient, associated attendee IDs, maximum sessions, issue/expiry
dates, closed/archived state and cancelled/DNA inclusion settings. The
[attendee creation contract](https://docs.api.cliniko.com/openapi/attendee/createattendee-post)
accepts `patient_case_id`; the resulting attendee exposes its case link. These
operations require native attendee identities, not an individual appointment
substitution or replacement of the whole case association list.

Provider OpenAPI snapshot used for this work: retrieved October 14, 2026 from
`https://docs.api.cliniko.com/_bundle/openapi.json?download`, SHA256
`4c354b3cb3fb9cf7ca91b5dd408b78f62896c62b89d265ba3190e5d2bd03740c`.
The archived provider availability-block documentation was also inspected; it
contains no additional repeat count, month-end or DST semantics. Recurring
extra opening hours remain unsupported pending an established contract.

## Private native boundary: E2E-405

`ClinikoPatientCaseSessionsReader` reads one exact native case chosen by
independent host authority. It never discovers a pass by a case name or allows
the model to choose a native ID. Current patient proof and independent
case/class permission bracket both complete source observations. A foreign
patient, changed subject, expired proof or revoked permission cannot publish
the result. The deploying host must explicitly accept the
`arrivedFalseIsDna` attendee status interpretation; the schema's boolean alone
does not constitute clinic approval.

The reader obtains every associated attendee across past/future appointments,
businesses and service types. Native `attendee_ids` and the complete paginated
case attendee collection must agree. Missing pages, duplicate or foreign
records, unsupported null tracking settings, malformed state and excessive
collections deny the read. It observes up to 1,000 associations; this bound
allows a session-limited case's historical cancelled/DNA records as well as its
maximum of 300 counted sessions. Larger cases require a different complete
reader, not a partial balance.

The counter excludes archived/deleted associations, then applies cancellation
before DNA. An uncancelled attendee with `arrived: false` is governed by the
case's DNA flag; an unmarked future attendee with `arrived: null` consumes a
session. Cancelled records follow the cancellation flag even if an earlier DNA
status remains. This interpretation, archive semantics and date boundaries
must be accepted for an actual clinic before serving traffic.

Issue and expiry dates are inclusive on the selected session's clinic date.
Closed or archived cases are ineligible. Full and overdrawn cases report zero
remaining sessions without hiding overdraw. Case notes, names, referrals and
attendee notes are discarded. The result remains host-private and explicitly
has no financial or reservation authority.

`ClinikoClassAttendanceWriter` can attach an explicitly supplied case when
creating one attendee. Its guarded native POST includes `patient_case_id`,
and both acknowledgement and subsequent exact inspection must match the
requested patient, session and case. An incorrect case acknowledgement or lost
response remains uncertain and cannot replay. Cancellation does not accept a
new case association. Existing requests without a case retain their original
wire body.

The native integration fixture combines protected case reads, current native
class capacity/duplicate reads, guarded creation and exact case inspection.
It proves that a late budget wait rechecks depletion, and that a concurrent
additional use can overdraw the case even after provider acknowledgement.
This is no atomic reservation; the caller host must inspect the resulting
case before reporting success and preserve uncertainty without another send.

## Remaining caller and lifecycle work

1. E406 supplies the independent pass-selection contract and local
   service/location/terms/permission checks. Actual clinic-owned entitlement
   provisioning and separate financial evidence still need acceptance.
2. E406 locally qualifies the binding from private selection through normal
   played consent, owned review, native send and final exact case/attendance
   inspection. Broader catalogue/correction/acceptance qualification remains.
3. Cancellation and movement with each clinic's consumption/release rules,
   including full cases, counted cancellations, expiry, cross-service moves,
   lost responses and compensating recovery. Do not claim a restored credit
   simply because attendance was cancelled.
4. E406 supplies six complete signed compiled booking journeys and privacy
   checks. Extend these to the remaining cancellation/movement and catalogue
   combinations; actual clinic/provider/operator acceptance is still absent.
5. Monetary account credit, deposit/payment/receipt/refund lifecycle under gap
   11. Neither this adapter nor the existing independent permission port
   implements those financial operations.

The full thirteen-gap goal stays open. Real delivery, acoustic/carrier
qualification and authoritative cloud checks remain separate requirements.


## Local qualification

E2E-405 and affected native/host/compiled class regressions: 221 passed, no
failures, cancellations or skips. Whole-source typecheck, fresh compiled voice
build, isolated PostgreSQL migrations and diff check passed. The tracked final
job completed in 2m22s, log `4590eee3-1792010939632.log`; exact commands are in
`THIRTEEN_GAP_IMPLEMENTATION.md`. This proves the private native boundary and
regression scope described above, not the unfinished pass caller workflow.


## E2E-406 ordinary caller pass booking

The class owner document can opt into `membership: "nativeCaseSessions"` with:

```json
{
  "attendanceStatus": "arrivedFalseIsDna",
  "counting": "allLinkedNonArchivedAttendees",
  "dates": "inclusiveClinicDate",
  "consumption": "onePerAttendance",
  "financialAuthority": "independentHost"
}
```

This object is the exact `caseSessions` field. Legacy class approvals cannot
include it. The approved booking terms must describe the intended pass use;
the synthetic owner terms explicitly say that the booking uses one session.
The same owner content and membership snapshot must remain current throughout.

The deploying class service supplies `passAuthority.select`, propagated to the
actual class session and booking host as `classPassAuthority`. Its private
query binds scope, call/session, patient, native class occurrence, service,
business, practitioner/type, interval, phase and approved terms version. The
independent authority must approve service/location and financial entitlement
and return one exact native case ID plus an opaque entitlement reference.
Neither the model nor a case name may supply that selection. An ambiguous or
unavailable independent selection cannot become a booking. Inspection remains
authorised for the last consumed session; remaining-session counts are checked
by the native reader, separately from that authority.

Each private offer and preparation retains the selected binding. Before review
and send the host requires unchanged selection and complete case state. Native
case IDs and entitlement references do not enter the public menu or spoken
consent. The core action's opaque offer identity binds the private selection.
A class attendance review v2 records the exact case, entitlement, prior usage
fingerprint and counts for staff investigation, without becoming a replay
permit. Legacy attendance reviews retain v1.

The native reader's private usage fingerprint binds the owning patient/case,
tracking rules, date/activity metadata and every associated attendee's identity,
booking, attendance and activity state. After a known attendee acknowledgement,
`inspectAddition` requires that exact new active attendee on the selected class,
then removes only that record and compares the entire remaining case state to
the prior fingerprint. The host also requires exactly one consumed session,
unchanged maximum, an eligible case date and no overdraw. Lost responses,
wrong-case acknowledgements, other use or status changes leave the action
unconfirmed, without a repeat mutation or an invented refund.

The signed compiled runner uses the actual exported serving entrypoint, normal
private verifier, SAM, physical PostgreSQL budget and provider adapters. Its
fixtures cover last-session success, independent denial, changed selection,
depletion, lost acknowledgement and concurrent additional use. Public/model
and database canary scans include private pass IDs and entitlement references.
Qualification results are recorded in the thirteen-gap implementation log.

This completes additional local pass-booking engineering, not gap10 closure.
Pass cancellation/movement still need explicit consumption/release and recovery
rules; the new native mode cannot use their legacy path. Actual independent
entitlement provisioning, clinic/provider/operator acceptance and monetary
credit/payment operations remain open.


### Capacity before pass confirmation

The first compiled pass-positive journey exhausted the real 180-request
PostgreSQL account budget during final inspection; 43 of 44 focused checks
passed and that success assertion correctly failed. No limit or post-write
assertion was changed. The pass booking host now uses the existing advisory
confirmation-capacity protocol before dispatch, with independent private
selection/policy/played-consent checks around headroom observation.

The core's previously move-only wait transition now also accepts a fully
approved booking action, with its own booking capability/evidence checks and
truthful unbooked/unreserved wording. The earlier affirmative is not retained
as permission to send: the normal notice must play and a later clear affirmative
is required. Every native request still claims the original shared account
budget. A second capacity check before the reviewed effect stops a known
insufficient send; it does not reserve quota or prevent concurrent consumers.

The compiled pass fixtures cross the real database minute window using normal
connected-call lease renewal and continuous quiet media. They require a new
affirmative, recheck complete native pass/class evidence and preserve the real
180 limit. Unit fixtures use their explicit clock and ordinary lease renewal,
without changing the budget limit or consent rules. Native pass booking still
requires full inspection, and uncertain concurrent outcomes do not replay.


### E406 qualification result

Final typecheck, fresh compiled build, isolated migrations and 298 affected
checks passed without failure, cancellation or skip. The six complete compiled
pass journeys and 16 existing class runner journeys passed, including real
quota-window waits, last-session success, actual 180-request limits and
public/model/PostgreSQL privacy scans. Log `4590eee3-1792012243302.log`,
tracked job `Abby E406 final pass caller and capacity qualification`, exit0,
4m17s. Exact commands are in `THIRTEEN_GAP_IMPLEMENTATION.md`.

The remaining lifecycle list above is still authoritative for unfinished work:
ordinary approved booking has additional local proof, while cancellation/move,
real entitlement provisioning, money and actual clinic acceptance stay open.
