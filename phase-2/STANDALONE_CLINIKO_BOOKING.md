# Standalone Cliniko best-effort booking

**Booking runtime revision:** [ADR 0002](../docs/adr/0002-provider-acknowledged-booking.md) makes exact provider acknowledgement the individual creation success boundary after final online/roster availability. Native class creation now follows the equivalent final-capacity/attendee-acknowledgement contract, including an independently approved pass; see [class passes](CLINIKO_CLASS_PASSES.md#creation-acknowledgement-revision). Movement, cancellation and relinking retain their separate inspection requirements. Clinic activation, independent review and exact-head CI remain separate gates.

## Status and declared contract

D-16 accepts best-effort standalone writes. `ClinikoBookingHost` supplies a local one-call/one-attempt booking host using the existing SAM, verifier, provider writers and review runner. It requires no invented exclusive-slot permit. The previous `TransientClinikoBookingHost` retains its exclusive-permit contract for its earlier embedded tests. None of these local constructions enable the production runner.

The new host executes only after current operation-bound patient proof, approved exact offer and provider metadata, current/captured clinic execution and staff support, played confirmation/clear affirmation, and an acknowledged exact Cliniko review. The clinic must accept remaining overlap, duplicate and competing-editor risks. Available time is not reserved, a final-read/POST race remains, and neither availability nor the creation acknowledgement promises atomic exclusion. Later observations cannot erase acknowledged success.

## Function and call map

| Function | Input | Output / work |
| --- | --- | --- |
| `ClinikoBookingSession.create` | Trusted admission/inbound/session, current owner-only caller/booking approvals, independent patient permission, delivery, mandatory shared provider budget and close signal | Bound verifier → concrete offers → private menu → reviewed booking host; one bounded constructor and one lifetime. Foreign/closed/stale bindings or approvals fail closed. No production activation endpoint. |
| `BookingMenuTurns.run` / `booking.offers.read.v1` | Final session turn, bounded dates, current time | Fresh call/policy/stop checks, verified concrete offer read, safe numbered SAM menu and generic command progress. One 15-second operation budget; conversation revision fences late publication. |
| `booking.offers.select.v1` / `ClinikoBookingMenu.selectBookingMenu` | New final turn, ordinal 1–3 and current time | Matching played menu plus private one-use mapping resolve opaque proof/offer, then propose the SAM action. Selection cannot replace the separate played confirmation and later affirmation. Private refs never enter command input/result or menu text. |
| `OwnerFileBookingPolicy.capture/current` | Owner-only public clinic approval, exact provider/policy bindings and current scoped administrator directory | Captured then freshly reread exact booking policy. Replacement, membership change, disabled/unapproved status, expiry or unsafe schema/file denies the call. Patient permission and staff receipt remain separate. |
| `ClinikoBookingOffers.list` | Scope, actual operation-bound proof ref, bounded clinic date range, current time and optional close signal | Up to three opaque, volatile patient/call-bound choices, each with exact start/end and fixed expiry. Provider eligibility, relationships, duration and names come from `ClinikoAvailabilityReader.listBooking`; current public policy filters notice/horizon. New listings invalidate prior selections. Availability is not a reservation. |
| `ClinikoBookingOffers.resolve` | Scoped call/session/policy, patient ID from proof, issued proof/offer refs, time, proposal/commit phase and abort signal | Fresh exact offered time on its approved business-calendar day, provider/label/duration and current public approval plus proof rechecks. Unknown/cross-call/expired/replaced offers deny; model-supplied provider IDs, timestamps or policy authority cannot mint evidence. |
| `ClinikoBookingGuard.resolve` | Scope, opaque proof/offer refs, time, phase and signal | Prepared portable booking plus private exact provider/interval/policy bindings. Checks active SAM admission/lease, automation/booking/execution/staff declaration, emergency stop, actual booking proof, trusted current evidence and final proof. Public approval IDs and opaque proof refs have distinct validation rules. |
| `ClinikoBookingGuard.authorize` | Prepared action, actual dispatched mutation, current time and signal | Boolean only after played presentation, correct SAM action/effect, fresh commit evidence, digest/provider/interval/policy match, proof and emergency checks. Called before and after saving review. Final dispatch uses the separate path below after the writer's budget claim. |
| `ClinikoBookingOffers.resolveForSend` / `ClinikoBookingGuard.authorizeForSend` | Exact prepared mutation and original deadline/signal | Fresh proof, captured/current approval, settings, stop, catalogue and native metadata preparation precede final exact availability. Catalogue wrappers forward this dispatch path; online readers finish metadata first, roster readers retain complete double calendar observations without a later metadata refresh. Only local expiry/proof/lifetime/digest checks follow. Ordinary proposal/reschedule reads retain their protected refresh contract. |
| `ClinikoBookingGuard.currentForSend` | Prepared request, clock and abort state | Synchronous final expiry/lifetime/proof check at actual transport invocation, including the exact session-lease deadline observed during final preparation. A renewal already observed before final availability supplies its newer deadline; an unobserved renewal cannot prolong this send window. It is not a replica of shared remote write-stop state. |
| `ClinikoBookingGuard.mayInspect` | Prepared action/mutation/current time/signal | Current SAM dispatch, proof, setting and call authority for protected read-back/conflict/result disclosure. It is outside the booking completion path and does not require that the just-booked slot remain available. |
| `ClinikoBookingHost.resolveBooking` | Existing versioned booking command's scope/proof/offer/time | One prepared portable booking or typed failure. One host owns one prepared action and possible attempt; it is not a multi-booking call manager. |
| `ClinikoBookingHost.write` | Confirmed SAM mutation/time/signal and trusted acknowledgement observer | Saves exact Cliniko-owned review before one possible POST. The fully validated native acknowledgement establishes committed status immediately, with no mandatory target/conflict GET or review auto-close. The observer propagates that result through cancellation, not through a new ledger. |
| `ClinikoBookingWriter.writeOnce` | Frozen scoped patient/start/end/marker request, signal, trusted final preparation, acknowledgement and synchronous dispatch callbacks | Claims the POST budget before final preparation/availability; only local final checks precede transport invocation. Validates the exact bounded HTTP 201 response and reports established success before asynchronous wrapper delivery. Possible sends are never replayed. |
| `ClinikoBookingWriter.inspectCreated` | Submitted private request, returned appointment ref, approved end time, signal and optional trusted final-read callback | Boolean exact active read-back after a clear create response: exact ID, marker, patient/business/practitioner/type links, start/end and explicit active statuses. Explicit authorized review only: a mismatch/unreadable result cannot establish an uncertain write or veto an acknowledged booking. |
| `ClinikoBookingWriter.inspectConflicts` | Returned ref, signal and optional trusted final-read callback | Typed current conflict boolean. A clear result does not reserve/exclude a racing writer. Both private read callbacks run after their budget waits. |
| `reconcile`, staff methods, `dispose` | Uncertain mutation or trusted call close | Always unresolved on later reconciliation, no provider retry/compensation and no automatic recall closure. General staff tasks remain unavailable. Dispose closes this host/review/prepared action; the call owner separately disposes its verifier/proof and offer source. |

`ClinikoBookingEvidence` binds scope, call/session/policy, exact patient/provider selection and credential fingerprint, opaque offer/service/start/expiry, end time, timezone and clinic booking-policy version. Its explicit `bestEffort` label states the contract; it is not permission. The review protocol's common `termsVersion` field carries that booking-policy version for review, without claiming fee assent or charging a fee. The concrete portable confirmation presents clinic-local time with time-zone name, public practitioner/service and exact approved duration; all presentation metadata is action-digest bound. Legacy embedded offers retain their existing wording. Any changed interval or terms after confirmation rejects the send.

## Unknown results and privacy

A lost recall acknowledgement permits no clinical POST. A possible booking send with a lost, incomplete, unparsed or nonexact response remains unknown. A fully validated acknowledgement establishes success even if proof subsequently expires, diary reads fail, conflicts appear or speech/reporting fails. There is no mandatory post-write inspection, automatic compensation, replay or recall closure. A later matching row does not attribute an uncertain write to Abby; reconciliation remains unresolved for staff review.

All call/proof/offer/marker/action/inspection state remains volatile. The only durable patient data permitted in Abby remains its clinic phone-to-Cliniko-ID index. The fixtures leave that index empty and persist only non-patient coordinated provider/verification budgets; actual row and backup canaries test the boundary. The host itself does not create a budget: the deployment owner must supply the same coordinated API-user budget to all concrete verification, offer, provider and recovery adapters.

## Evidence and remaining work

E2E-279 now covers actual email-code proof, played SAM affirmation, confirmed provider review and exact native acknowledgement, including loss/malformed uncertainty and preserved success after observer failure or host shutdown. Earlier inspected-result receipts describe historical behavior. PostgreSQL budgets/backups and sender SIGKILL cases continue to prove privacy and provider-owned discovery without replacement mutation.

E2E-280 covers the actual provider send/read hooks after budget waits, false/throw/held/aborted denial, immutable request binding, exact link/marker/status/duration checks and a real emergency stop at the writer's final reservation.

E2E-281/282 add the concrete public approval and offer source to the actual email-proof/SAM/review/booking path, shared PostgreSQL budgets and backup scans. The booking-owner SIGKILL journey now constructs that source too. Fixtures supply synthetic public approval, mail, independent permission and provider responses; this is engineering evidence, not an actual clinic approval. Interrupted protected refreshes pass their abort signal into the verifier/contact reader, so releasing a held budget after an offer deadline cannot cause a late contact request or publish an offer. Cancelled refreshes conservatively revoke the proof.

E2E-283/284 now cover the actual admitted booking session, agent menu and ordinal selection with localized confirmation, held construction/read fences, shared-budget denial and actual PostgreSQL/backup plus composed-owner SIGKILL proofs. Mail, independent permission, operator approvals and provider responses are synthetic.

Still required: real verifier/permission/mail integration; actual clinic/recovery/notification approval with human staff witness; actual provider side-effect checks; and gated caller/voice-runner integration. The owner deferred real email-service setup on 2026-10-04; local synthetic email tests continue. Cancellation/booking activation and the full nine-step objective remain incomplete.

## Public booking approval template

Provision only public clinic configuration in an owner-only regular file, atomically replaced by an authorized operator. `OwnerFileBookingPolicy` accepts exactly this schema (8 KiB maximum); patient/contact/note fields are rejected. This template is deliberately disabled and unapproved. Its identifiers, times, administrator, fingerprint and clinical values are placeholders and do not establish approval:

```json
{
  "scope": { "tenantId": "demo", "clinicId": "clinic", "locationId": "main" },
  "revision": "booking-1", "approverRef": "clinic-admin",
  "approvedAt": "2026-10-04T06:00:00.000Z",
  "effectiveFrom": "2026-10-04T06:00:00.000Z",
  "effectiveUntil": "2026-10-05T06:00:00.000Z",
  "approved": false, "enabled": false, "policyVersion": "captured-call-policy",
  "businessId": "11", "practitionerId": "22", "appointmentTypeId": "33",
  "credentialFingerprint": "0000000000000000000000000000000000000000000000000000000000000000",
  "recallTypeId": "7", "timeZone": "Australia/Sydney",
  "writeContract": "bestEffort", "notificationOwner": "cliniko",
  "serviceRef": "physiotherapy", "bookingPolicyVersion": "booking-policy-1",
  "durationMinutes": 30, "minNoticeMinutes": 60,
  "maxAdvanceDays": 30, "offerTtlSeconds": 120
}
```

Duration must equal current Cliniko appointment-type metadata and is limited to 1–480 minutes. Notice is 1–10,080 minutes; horizon is 1–90 days and must exceed notice; offer lifetime is 15–300 seconds and is capped by proof and approval expiry. The source rereads the exact available time in the approved business timezone, including daylight-saving calendar boundaries, at every authorization phase. Provider/customer edits can still race a POST; no atomic exclusion is implied. `serviceRef` is the approved portable service identifier, not an instruction, a provider ID or patient-specific text. No fee is charged and no patient permission is inferred from this public approval.

The concrete offer source and booking/cancellation guards require `TransientPatientProofHost.matchesCall` for exact clinic/call/session/captured-policy ownership at construction. A valid verifier from another simultaneous call cannot be rebound by trusted composition configuration; this check exposes no presented phone, patient or proof token. E2E-281 reproduces the previously accepted foreign-call construction and asserts rejection before provider traffic.
