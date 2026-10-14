# Cliniko class passes and session tracking

Gap 10 includes membership/pass/credit handling. E405 supplies the native
adapter, E406 connects approved pass booking to the ordinary caller host, and
E407 adds native cancellation with verified session-use effects. E408 adds
guarded association updates, exact unlinked staging reads and whole-case
movement inspection. E409 composes a native pass movement/recovery coordinator. Caller movement,
broader/mixed catalogue qualification and financial handling remain unfinished.
Real clinic activation remains unqualified.

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
3. E407 supplies explicit native cancellation effect/inspection contracts and
   caller journeys, including full/expired/closed cases and lost outcomes.
   Movement, cross-service consumption/recovery and broader clinic-rule
   combinations remain. Attendance cancellation alone grants no money refund.
4. E406 supplies six compiled booking journeys and E407 adds eight compiled
   cancellation journeys. Extend these to movement and broader catalogue/
   correction cases; actual clinic/provider/operator acceptance is absent.
5. Monetary account credit, deposit/payment/receipt/refund lifecycle under gap
   11. Neither this adapter nor the existing independent permission port
   implements those financial operations.
6. Qualify larger case histories and mixed case-linked/cash attendance through
   the complete caller protocol under the physical account budget. The native
   reader's 1,000-association bound has separate adapter evidence; current caller
   proofs use small package histories.

The full thirteen-gap goal stays open. Real delivery, acoustic/carrier
qualification and authoritative cloud checks remain separate requirements.

## E2E-408 native pass movement prerequisites

The current [attendee update contract](https://docs.api.cliniko.com/openapi/attendee/updateattendee-patch)
accepts `patient_case_id`, `notes` and `arrived`. It does not document changing
`booking_id` or `patient_id`. Abby therefore does not implement an in-place class
move by inventing either field. A class move requires separate existing-session
attendance operations and explicit recovery authority.

`ClinikoClassAttendanceWriter` now accepts a private `linkCase` request for one
exact Abby-created replacement. It sends only `patient_case_id` to
`PATCH /attendees/:id`, expects HTTP 200 and validates the exact native self,
patient, booking and requested case links, active status and creation-action
marker. Arrival must be null or true. Neither notes, arrival, class, patient nor
the entire case's attendee list is written. The independent host must approve
the previous association and the change, with current pass, class, capacity,
consent/review and recovery checks. This primitive alone grants none of them.
It cannot clear an association using an undocumented null case ID.

An association action has its own UUID, distinct from the attendance creation
action. It shares the writer's normal account budget and no-replay reservation.
Authority is checked after the final budget wait. Once invoked, a lost, aborted,
incorrect or non-200 result remains uncertain; it cannot automatically retry,
cancel the replacement or recreate the original. An accepted update still needs
exact guarded readback and complete case inspection before any caller result.

`ClinikoPatientCaseSessionsReader.inspectMovement` observes the complete case
twice under current proof/independent permission. It requires the original
attendance cancelled on the exact old class, and a distinct active non-DNA
replacement on the exact destination class. Removing only the replacement and
normalizing only the original's cancellation must reproduce the prior case's
full usage fingerprint. Metadata, rules, every other association and status
must remain unchanged. The resulting usage may be unchanged or consume extra
sessions according to cancellation and DNA rules; the host must separately
approve and verify that effect. Cross-case movement can use the existing exact
source cancellation and destination addition inspections, with separate
authority for both cases.

Creating without `patient_case_id` does not prove that the provider leaves the
replacement unlinked. Its response schema also does not establish a concrete
nil-link shape. The additional provider [filtering contract](https://docs.api.cliniko.com/#filtering-results)
documents `!?` for numeric null fields, and attendee queries document
`patient_case_id`, `id`, `patient_id` and `booking_id`. `inspectUnlinked` therefore
reads the exact replacement twice with all four predicates, including
`patient_case_id:!?`. Both complete responses must contain only that exact
active, non-DNA attendance and creation marker. A positive case link contradicts
the filter and denies; absence alone never supplies evidence. An auto-linked
attendance returns no matching row and cannot authorize original cancellation.
Current independent permission and account budget surround the observations.
No attendee is mutated by this read and it reserves neither pass nor capacity.

This qualifies necessary native operations, not an ordinary caller move.
Cliniko's package guidance says the maximum limits associated appointments;
temporary overdraw is not an approved staging strategy. Full passes need an
explicit host-approved temporary unlinked stage, exact fresh case/attendance
checks, recovery consent and final linking/inspection. The native is-null read
now supplies provider evidence for staging without assuming a response shape;
the caller coordinator and its failure handling still need implementation. Do
not substitute whole-case association replacement or cancel the original first
under the existing replacement-first consent.

Remaining work includes the explicit host staging/recovery contract, movement authority,
played effect/recovery terms, versioned review and complete signed/compiled
caller journeys under the physical shared quota. Native pass movement stays
disabled in the caller host while those requirements remain unmet. No payment,
invoice, account credit or refund is inferred from an association update.


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


## E2E-407 ordinary caller pass cancellation

A native case-session owner document may additionally approve a `cancellation`
object with exactly `version`, `releaseOne`, `unchanged` and `consumeOne`. Each
effect has separately approved text of at most 200 characters. A booking-only
pass approval still cannot activate cancellation. The class service supplies
a separate `passCancellationAuthority`, carried into the actual cancellation
session/host as `classPassCancellationAuthority`; ordinary operation permission
and fee approval remain independent. Movement is still gated.

The independent selection query binds the exact patient, class occurrence,
attendee, service/location/practitioner/type, fee terms, pass terms version and
phase. An initial effect-free proposal permits private case inspection only.
The native reader then verifies that exact existing active attendance belongs
to the selected case, and identifies its real contribution under the DNA rule.
The independent authority must approve the resulting effect for the same
case/entitlement before consent or mutation. A changed case is never silently
substituted.

Cancellation contribution is governed by `include_cancelled_attendees`. The
change in used sessions is that contribution minus the attendance's prior
contribution. Thus cancelling may release one session, preserve usage, or
consume one previously excluded DNA attendance. Approved fee/pass terms and
the exact effect are bound to SAM consent and a distinct cancellation-pass
review protocol. This does not establish a money refund or extend an expired
pass. Full, expired, closed and already overdrawn cases can still lose their
attendance under the explicit policy; their other metadata remains unchanged.

After the one native cancellation, exact attendee inspection and complete
case inspection are both required. The case reader normalizes only that
attendee's cancelled state back to its previously active value and compares
the complete prior usage fingerprint. All other associations, attendance
statuses, case dates/activity, maximum and count settings must still match.
The actual final counter must equal the approved delta. Another change cannot
hide behind an equal net count. Lost review or mutation acknowledgement and
post-send drift remain uncertain and cannot replay or manufacture a credit.

The cancellation host uses the same advisory account-capacity protocol as pass
booking. The core cancellation wait checks cancellation policy/capability and
current evidence, says that attendance has not been cancelled, and requires a
new affirmative. Normal leases and the physical request limit stay unchanged;
all provider reads/writes continue to claim quota. Concurrent late consumers
can still cause an uncertain outcome.

Local native/host evidence and eight separately compiled caller cases cover
these effects, real quota waits, independent authority, native drift, lost
responses, other use, same-net swaps and public/model/PostgreSQL privacy.
Final results are recorded in the thirteen-gap implementation log.

Native pass movement and broader/mixed catalogue and correction cases remain
unfinished, together with real independent entitlement/financial provisioning
and actual clinic/provider/operator acceptance. This is additional cancellation
engineering; financial account credit/refunds, the full gap10 and full thirteen
gaps are not declared complete.


### E407 qualification result

Whole-source typecheck, fresh compiled build, isolated migrations, diff checks
and 391 affected checks passed, with zero failures, cancellations or skips.
The final tracked run completed exit0 in 5m31s, log
`4590eee3-1792013663745.log`. It includes eight compiled pass cancellation
journeys, six pass bookings and sixteen existing class journeys. The real
quota window, actual 180-request limit, normal leases, later affirmative and
public/model/PostgreSQL privacy checks remained in force. Exact commands are
in `THIRTEEN_GAP_IMPLEMENTATION.md`. Larger/mixed case histories, native pass
movement, financial operations and actual acceptance remain unfinished.


E408 local qualification: the existing native/host/signed/compiled regression
stage passed440 checks with no failures/skips. After adding filtered staging,
a fresh whole-source typecheck/build and136 current-source native/registry
checks passed with no failures/skips. Both stages passed diff checks. Counts
overlap; E408 adds no completed caller movement journey. Exact commands,
chronology, corrected fixture failures and tracked logs are recorded in
`THIRTEEN_GAP_IMPLEMENTATION.md`.


## E2E-409 native pass movement and recovery

`ClinikoClassAttendanceMove` has an explicit optional `casePass` configuration:
an independent `ClassPassMoveAuthority` and an approved `stagingContractVersion`.
A native request must contain the matching private `ClassMovementPass`; the
legacy configuration cannot accept that request, and a native configuration
cannot silently run without it. This is a native coordinator contract. The
ordinary move host still rejects native-case membership pending its explicit
owner terms, proposal binding and serving qualification.

`ClinikoClassPassMovement` obtains the independently selected source and
destination case/entitlement pair. Selection alone grants only private inspection.
The separate `allows` check must approve the actual cancellation effect,
temporary unlinked replacement, destination use and recovery version. Both ports
receive exact scope, patient, original attendance/occurrence, destination
occurrence, practitioner/type, policy/terms versions and phase. Channel proof,
case naming or an available session cannot supply these permissions.

Complete source inspection determines whether cancellation releases one session,
leaves use unchanged or consumes one formerly excluded DNA session. Destination
inspection checks its own clinic-date eligibility and resulting capacity. For
the same case, the two snapshots must agree; final use is original use plus the
cancellation effect plus one replacement session. A full case can therefore move
when cancellation releases the original session. It cannot fund an additional
session when cancellation retains or increases use. A separate eligible case
can fund a move from an expired/closed source, provided the source effect is
independently authorised and does not add an unfunded counted session.

The coordinator performs these guarded steps:

1. Journal the caller-confirmed proposal in one owned native review under live
   proof, independent move/pass permission and exact private bindings. This
   records proposed context and does not assert current native availability.
2. After the review and final budget claim, inspect both classes and complete
   cases before creating one replacement attendance without a case ID.
3. Inspect that exact replacement, then prove it currently unlinked with two
   exact native is-null queries. Auto-association remains uncertain and cannot
   authorise original cancellation or automatic financial compensation.
4. Before cancelling the original, freshly inspect both classes, unlinked
   replacement and unchanged complete cases. Inspect the exact cancellation.
5. Before linking the replacement, freshly inspect destination attendance and
   capacity, unlinked staging, and the complete source cancellation/destination
   case state. Change only the replacement's `patient_case_id` and inspect it.
6. Confirm only after fresh destination capacity and exact complete-case
   movement effects. Same-case inspection normalises exactly the original
   cancellation plus replacement addition. Cross-case inspection separately
   proves source cancellation and destination addition. The final case read
   proves the selected original's old booking and cancellation, so no redundant
   source-class roster read is needed for that record. Existing legacy movement
   retains its own full paired-roster contract.

Every provider request still claims the ordinary shared account budget. No
limit, timeout, assertion or final case/capacity check was relaxed to fit the
pipeline. The native cross-service tests initially exhausted the budget before
linking. Journalling proposed context before the mandatory pre-write live reads,
and using the complete source case proof for the exact cancelled original,
remove repeated observations without dropping the relevant evidence. Small-case
same/cross-service and same/cross-case native journeys now complete under the
unchanged budget of 180 requests. This does not qualify larger histories through
the entire caller protocol.

Compensation may cancel only a known replacement when original cancellation was
never sent. It requires fresh independent recovery permission, unchanged cases
and unlinked staging, then proves the exact cancelled replacement is still
unlinked using the documented `cancelled_at:*` inclusion filter. The original
and cases must remain unchanged. Once original cancellation is invoked or
uncertain, no automatic rollback or duplicate original is allowed. A denied or
unknown final association leaves explicit staff-review state; no pass usage,
attendance, payment or refund outcome is invented. Distinct deterministic UUIDs
identify replacement, original cancellation, compensation and final association.

### Bounded private movement review

`Abby class pass movement review v1` uses a losslessly compressed fixed JSON tuple within the existing
1,000-character recall summary bound. All scope/patient/business/credential,
policy/terms/timezone/time, original and destination interval/type/practitioner,
root action/recovery/cancellation reason, both exact case/entitlement/full-state
fingerprints/counters, source effect and staging version are preserved. Nothing
is truncated or replaced by a summary hash. The existing decoder returns the
full named context for private staff recovery; a parsed record is never a send
permit. Legacy review encoding remains unchanged.

The outer tuple has ten slots: scope triple, patient, business, credential
fingerprint, policy version, terms version, timezone, creation time, fourteen-slot
movement tuple, and three-slot pass tuple. The movement tuple contains original
practitioner/type/start/end/session/attendee, destination session/start/end,
optional destination practitioner/type (null when absent), root action UUID,
cancellation reason and compensation contract. The pass tuple holds source
case/entitlement/fingerprint/maximum/used/effect, destination
case/entitlement/fingerprint/maximum/used, and staging version. Tuple lengths,
all named-field invariants, header relationship and total note length are
validated on decode. Oversized context is rejected rather than truncated.

The native tests cover twelve case/service/effect combinations, full passes,
expired-source transfer, permission/source/entitlement/rule drift, restored
originals, auto-linked staging, same-net case swaps, concurrent usage/capacity,
unknown review and every write leg, recovery association drift, private result
boundaries and malformed/oversized reviews. Ordinary owner-approved played
consent, host offers/corrections, signed/compiled pass movement, larger/mixed
histories and actual clinic/financial/cloud acceptance remain unfinished.


The pass movement payload line is `z1:` plus canonical base64url of raw DEFLATE
for that JSON tuple. Node's built-in zlib supplies the encoding; no dependency
was added. Encoding and decoding bound the uncompressed payload to8,192 bytes, with inflation limited before strict UTF-8/JSON,
tuple and named-context validation. The existing1,000-character summary limit
still applies before decompression. Compression is an encoding, not a privacy
control; the complete review remains private staff context. Legacy reviews
retain their original JSON wire format.

A diagnostic with full native identifier widths and ordinary UUID-based scope,
policy and entitlement references found the first plain tuple exceeded the note
limit. A committed positive regression now proves exact round-trip recovery for
19-digit identifiers and UUID references. Corrupt, noncanonical, invalid UTF-8
and excessive-inflation payloads deny, and genuinely oversized high-entropy
context is rejected without truncation. Bounded convenience inflation is
specified in the [Node zlib options](https://nodejs.org/download/release/v22.16.0/docs/api/zlib.html#class-options).


E409 final local qualification:507 regression checks passed, followed by a fresh
current-source type/build/migration gate and164 native/staff-review checks.
Both stages had zero failures/cancellations/skips and passed diff checks; counts
overlap. Exact commands, intermediate failures/diagnostics and tracked logs are
recorded in `THIRTEEN_GAP_IMPLEMENTATION.md`. This qualifies the native
coordinator, not the unfinished ordinary caller pass movement flow.

## Ordinary caller pass movement (E410, local qualification)

The class movement host now binds independent source/destination pass selection
to each private destination offer. The public proposal includes the clinic's
approved fee, actual pass effect and recovery wording before confirmation.
All six same/different-case effect variants require explicit versioned owner
text. Source, destination and movement approvals must agree on native session
tracking. The service catalogue and admitted class owner require a separate
selection and actual-effect authority; possession of a caller code or a case
balance cannot supply it.

The played proposal's terms digest binds its complete private pass evidence.
Proposal inspection uses the owner/fee terms version; commit authorization uses
the actual combined SAM terms version. Both phases must approve the same exact
pass selection, service pair and staging contract. Changed rules, counters,
entitlements or approvals invalidate the proposal. No pass identifiers or
financial fingerprints are added to public messages or stored core actions.

The native coordinator groups related GET observations between writes. Each
group verifies the actual operation-bound patient proof and native contact
before and after all reads, discards everything on revocation or subject change,
and closes its temporary proof before returning. Internal complete snapshot,
source, rule and permission checks remain. No clinical write or protected result
publication is allowed inside the callback. Fresh financial permission is
required after group closure, and every clinical send remains outside the group
under the native writer's existing budget claim and final permission gate.
The scoped proof cannot be reused by later reads or writes.

This avoids repeated native contact fetches within a single private observation
while retaining actual proof checks around every observation and between every
write. The physical 180-request account limit, 15-second native deadlines,
normal call leases and existing offer expiry remain unchanged. When the account
needs a fresh quota window, the caller hears a wait notice and must say yes
again after playback and the ordinary elapsed wait. The host does not reserve
quota or pass credits.

Initial caller/native checks passed89 tests, including permission and native
contact changes inside an observation. The next source type/build and14
admission checks passed. Final native/owner/legacy/review regression passed279
checks, then fresh type/build/migrations and40 compiled/contract checks passed;
all stages had zero final failures, cancellations or skips, and counts overlap.
The compiled journeys include full and cross-case/service/instructor/duration
moves, live authority/selection/rule denials, lost association and concurrent-use
uncertainty with no replay. Public/model/storage scans include every plain
canary and every bounded fragment of the complete compressed native review.
The first compiled diagnostic failures and their test-only corrections are
recorded in `THIRTEEN_GAP_IMPLEMENTATION.md`. Larger/mixed histories, broader
catalogue/correction combinations, deploying-host financial provisioning,
actual clinic acceptance and authoritative cloud qualification remain open.


## Complete mixed histories and ordered native observations (E411)

Local caller/native qualification now includes501 existing linked associations
on a same-service/same-case move and201 associations on each side of the other
case/service/instructor/duration combinations. Cancelled, DNA, archived and
deleted uses on unrelated bookings remain in the full private fingerprint even
when excluded from the counter. A same-count booking-link change on the last
page prevents confirmation. These are specific qualified workloads, not an
unbounded history-size claim.

Native class metadata is fresh before the first complete roster snapshot and
after the second. The second snapshot now reads its metadata at the end, so no
middle duplicate is needed. Both complete roster observations, exact native
relationships, final metadata validation and real proof at both outer boundaries
remain. Drift tests place mutations between the actual snapshots and also
assert the bracketing order; final-scan metadata revocation still denies.

After replacement creation, two exact native is-null observations prove the
active patient's record, class, creation marker and unlinked staging in the same
private group as the current class/case observations before original cancellation.
Original cancellation is proved by both complete stable case snapshots, with
the exact approved native reason, source booking and original identity. The
separate original-attendee GET is therefore unnecessary. Final linked-attendee
GET/creation-marker inspection remains in the closing group, followed by complete
case and current capacity checks. A group can record a known unlinked replacement
only after real proof and financial authorization close; this preserves guarded
compensation when cancellation permission or capacity is denied.

After the private proposal journal, owned review/financial permission is current;
the first subsequent protected provider operation still begins with actual
native contact verification and closes it after all observations, before any
clinical send. No proof is cached across any provider write. Limits and deadlines
remain unchanged.

The private reader now reports associationCount separately from used sessions.
An addition is denied when it would exceed the existing1000-association complete
inspection bound. Remaining paid sessions cannot authorize an uninspectable
addition. No raw cancellation reason, notes or referral content leaves the edge;
the expected reason is checked internally and excluded from the existing counter
fingerprint encoding, preserving that wire contract.

The initial larger-history probe found post-send quota exhaustion on some
workloads. Consolidation and the metadata ordering reduce actual requests and
qualify the sizes above; larger cross-case histories can still exhaust the
physical budget. Complete cost admission and staged multi-window movement remain
unfinished, alongside catalogue/correction combinations, financial provisioning
and real clinic/cloud/voice acceptance. Current type/build/native qualification and the final rebuilt state-including
signed serving gate passed:280 native checks,134 focused checks and60 compiled/
contract checks, with overlapping counts and zero final failures/cancellations/
skips. Exact logs and diagnosed intermediate failures are recorded in
`THIRTEEN_GAP_IMPLEMENTATION.md`.


### Explicit native state inclusion

Cliniko documents the DateTime wildcard for including inactive records on
endpoints that otherwise exclude them: [filtering results](https://docs.api.cliniko.com/#filtering-results).
The [Attendee API](https://docs.api.cliniko.com/openapi/attendee/listattendees-get)
supports archived_at, cancelled_at and deleted_at filters, and the
[Patient Case API](https://docs.api.cliniko.com/openapi/patient-case/listpatientcases-get)
supports archived_at on exact case reads. Complete case collections now request
all three state wildcards; case metadata requests archived cases explicitly.
These inclusion predicates do not restrict the case by service, patient or date.
Every returned record is still checked against the exact private association set.

Exact own-attendee inspections also include inactive states explicitly. An
archived or deleted record cannot satisfy an active/cancelled receipt merely
because the API returned it: all existing patient/booking/state/reason/marker
checks remain. Native fixture providers independently hide each inactive state
unless requested. A new red test exposed the old implicit-default assumption;
the corrected reader passes the full history and exact cancelled-record checks.
This is documentation-based adapter qualification; no live patient API was used.
