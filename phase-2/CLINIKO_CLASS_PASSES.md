# Cliniko class passes and session tracking

Gap 10 includes membership/pass/credit handling. A complete caller workflow is
still unfinished. The native adapter below is a prerequisite, not an activated
class-pass feature or evidence that financial handling is complete.

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

1. Clinic-owned pass selection and service/location eligibility, separate
   financial evidence, versioned terms and current permission.
2. Bind the selected case to normal played consent and the owned booking
   review, carry that immutable association into the final native send, and
   inspect the final counter as well as exact attendance before confirmation.
3. Cancellation and movement with each clinic's consumption/release rules,
   including full cases, counted cancellations, expiry, cross-service moves,
   lost responses and compensating recovery. Do not claim a restored credit
   simply because attendance was cancelled.
4. Actual compiled/signed caller journeys, privacy checks and independent
   clinic/provider acceptance. Native adapter tests do not supply these.
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
