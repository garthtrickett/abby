# Standalone Cliniko best-effort booking

## Status and declared contract

D-16 accepts best-effort standalone writes. `ClinikoBookingHost` supplies a local one-call/one-attempt booking host using the existing SAM, verifier, provider writers and review runner. It requires no invented exclusive-slot permit. The previous `TransientClinikoBookingHost` retains its exclusive-permit contract for its earlier embedded tests. None of these local constructions enable the production runner.

The new host executes only after current operation-bound patient proof, approved exact offer and provider metadata, current/captured clinic execution and staff support, played confirmation/clear affirmation, and an acknowledged exact Cliniko review. The clinic must accept remaining overlap, duplicate and competing-editor risks. Available time is not reserved, a final-read/POST race remains, and clear post-send inspection is a best-effort observation rather than atomic exclusion.

## Function and call map

| Function | Input | Output / work |
| --- | --- | --- |
| `OwnerFileBookingPolicy.capture/current` | Owner-only public clinic approval, exact provider/policy bindings and current scoped administrator directory | Captured then freshly reread exact booking policy. Replacement, membership change, disabled/unapproved status, expiry or unsafe schema/file denies the call. Patient permission and staff receipt remain separate. |
| `ClinikoBookingOffers.list` | Scope, actual operation-bound proof ref, bounded clinic date range, current time and optional close signal | Up to three opaque, volatile patient/call-bound choices, each with exact start/end and fixed expiry. Provider eligibility, relationships, duration and names come from `ClinikoAvailabilityReader.listBooking`; current public policy filters notice/horizon. New listings invalidate prior selections. Availability is not a reservation. |
| `ClinikoBookingOffers.resolve` | Scoped call/session/policy, patient ID from proof, issued proof/offer refs, time, proposal/commit phase and abort signal | Fresh exact offered time on its approved business-calendar day, provider/label/duration and current public approval plus proof rechecks. Unknown/cross-call/expired/replaced offers deny; model-supplied provider IDs, timestamps or policy authority cannot mint evidence. |
| `ClinikoBookingGuard.resolve` | Scope, opaque proof/offer refs, time, phase and signal | Prepared portable booking plus private exact provider/interval/policy bindings. Checks active SAM admission/lease, automation/booking/execution/staff declaration, emergency stop, actual booking proof, trusted current evidence and final proof. Public approval IDs and opaque proof refs have distinct validation rules. |
| `ClinikoBookingGuard.authorize` | Prepared action, actual dispatched mutation, current time and signal | Boolean only after played presentation, correct SAM action/effect, fresh commit evidence, digest/provider/interval/policy match, proof and emergency checks. Called before review, after review and after the writer's budget reservation. |
| `ClinikoBookingGuard.mayInspect` | Prepared action/mutation/current time/signal | Current SAM dispatch, proof, setting and call authority for protected read-back/conflict/result disclosure. It does not require that the just-booked slot remain available. |
| `ClinikoBookingHost.resolveBooking` | Existing versioned booking command's scope/proof/offer/time | One prepared portable booking or typed failure. One host owns one prepared action and possible attempt; it is not a multi-booking call manager. |
| `ClinikoBookingHost.write` | Confirmed SAM mutation/time/signal | Rejected, uncertain or best-effort committed receipt. `ClinikoReviewedSend` saves the full confirmed provider-owned review before `ClinikoBookingWriter.writeOnce`; it then uses exact created-target and conflict inspections before a committed receipt. Managed Abby notifications are not accepted. |
| `ClinikoBookingWriter.writeOnce` | Frozen scoped patient/start/marker request, optional signal and trusted final-send callback | One possible POST per process marker, with bounded budget/authority/provider waits. The callback is never an agent command/schema. Input mutation during a wait cannot change the send target. |
| `ClinikoBookingWriter.inspectCreated` | Submitted private request, returned appointment ref, approved end time, signal and optional trusted final-read callback | Boolean exact active read-back after a clear create response: exact ID, marker, patient/business/practitioner/type links, start/end and explicit active statuses. A mismatch/unreadable result cannot confirm. |
| `ClinikoBookingWriter.inspectConflicts` | Returned ref, signal and optional trusted final-read callback | Typed current conflict boolean. A clear result does not reserve/exclude a racing writer. Both private read callbacks run after their budget waits. |
| `reconcile`, staff methods, `dispose` | Uncertain mutation or trusted call close | Always unresolved on later reconciliation, no provider retry/compensation and no automatic recall closure. General staff tasks remain unavailable. Dispose closes this host/review/prepared action; the call owner separately disposes its verifier/proof and offer source. |

`ClinikoBookingEvidence` binds scope, call/session/policy, exact patient/provider selection and credential fingerprint, opaque offer/service/start/expiry, end time, timezone and clinic booking-policy version. Its explicit `bestEffort` label states the contract; it is not permission. The review protocol's common `termsVersion` field carries that booking-policy version for review, without claiming fee assent or charging a fee. The portable confirmation presents service/start; selected duration stays bound and any changed interval after confirmation rejects the send.

## Unknown results and privacy

A lost recall acknowledgment permits no clinical POST. A possible booking send with a lost/nonexact response remains unknown. A clear response followed by changed/unreadable target or conflict inspection also remains unresolved. Removing a later conflict cannot silently promote the action. No automatic cancellation, delete, replay or compensation occurs. Review remains Cliniko-owned and pending; saving it proves neither staff receipt nor notification.

All call/proof/offer/marker/action/inspection state remains volatile. The only durable patient data permitted in Abby remains its clinic phone-to-Cliniko-ID index. The fixtures leave that index empty and persist only non-patient coordinated provider/verification budgets; actual row and backup canaries test the boundary. The host itself does not create a budget: the deployment owner must supply the same coordinated API-user budget to all concrete verification, offer, provider and recovery adapters.

## Evidence and remaining work

E2E-279 covers actual dedicated email-code proof, real text gateway/SAM confirmation, reviewed booking and provider inspection, plus wrong operation/scope/call/session/provider/interval/policy, current setting/approval/member/proof/lease/write-stop revocation, lost responses, conflicts and no later promotion. Actual PostgreSQL budgets/backup scans and SIGKILL before review acknowledgment, during POST and after inspected completion prove fresh provider-owned recovery without replacement mutations.

E2E-280 covers the actual provider send/read hooks after budget waits, false/throw/held/aborted denial, immutable request binding, exact link/marker/status/duration checks and a real emergency stop at the writer's final reservation.

E2E-281/282 add the concrete public approval and offer source to the actual email-proof/SAM/review/booking path, shared PostgreSQL budgets and backup scans. The booking-owner SIGKILL journey now constructs that source too. Fixtures supply synthetic public approval, mail, independent permission and provider responses; this is engineering evidence, not an actual clinic approval. Interrupted protected refreshes pass their abort signal into the verifier/contact reader, so releasing a held budget after an offer deadline cannot cause a late contact request or publish an offer. Cancelled refreshes conservatively revoke the proof.

Still required: caller-facing offer-list presentation/selection and the admitted booking-session composition; real verifier/permission/mail integration; actual clinic/recovery/notification approval with human staff witness; actual provider side-effect checks; and gated caller/voice-runner integration. This is progress on booking, not completion of cancellation activation, booking activation or the full nine-step objective.

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
