# Standalone Cliniko best-effort booking

## Status and declared contract

D-16 accepts best-effort standalone writes. `ClinikoBookingHost` supplies a local one-call/one-attempt booking host using the existing SAM, verifier, provider writers and review runner. It requires no invented exclusive-slot permit. The previous `TransientClinikoBookingHost` retains its exclusive-permit contract for its earlier embedded tests. None of these local constructions enable the production runner.

The new host executes only after current operation-bound patient proof, approved exact offer and provider metadata, current/captured clinic execution and staff support, played confirmation/clear affirmation, and an acknowledged exact Cliniko review. The clinic must accept remaining overlap, duplicate and competing-editor risks. Available time is not reserved, a final-read/POST race remains, and clear post-send inspection is a best-effort observation rather than atomic exclusion.

## Function and call map

| Function | Input | Output / work |
| --- | --- | --- |
| `ClinikoBookingAuthority.resolve` | Scoped call/session/policy, patient ID from proof, proof/offer refs, time, proposal/commit phase and abort signal | Typed fresh `ClinikoBookingEvidence` or unavailable/not-found. The real clinic offer/eligibility/policy source is still to be implemented; the executable fixture provides synthetic evidence. It must not accept provider IDs, timestamps or policy authority from model output. |
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

The mail, independent patient permission, approved offers/eligibility and provider are synthetic. Still required: concrete current clinic booking/offer source; call-bound offer presentation/selection; a real verifier/permission/mail integration; approved clinic/recovery/notification process with human staff witness; actual provider side-effect checks; and gated caller/voice-runner integration. This local host is progress on booking, not completion of cancellation activation, booking activation or the full nine-step objective.
