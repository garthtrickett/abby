# Automatic restrictive outbound stop decisions

The clinic owner selected automatic Cliniko DNC recording when an authenticated provider reports that anyone at the dialled number asked calls to stop. This module implements the conditional recording owner, without activating outbound calling.

## Evidence and ownership

`ClinikoOutboundStopOwner.retainStopOnce` starts from one exact native possible-attempt binding. Its v3 context must already carry the future DNC action and approval IDs allocated before the original transport. Older attempts cannot invent recovery IDs. The provider reference and effective credential/profile digest must still match the original attempt.

The selected trusted `OutboundStopProvider` must own authenticated native correlation and durable stop evidence for the exact effect/allocation pair. Its strict report contains the actual dialled number, `anyAtDialledNumber`, stop time and observation time. A model summary, unverified callback or claimed patient identity cannot supply this port. `none` and `unknown` leave recovery unresolved; neither permits another call.

The original Cliniko request must remain readable and match its recorded digest, campaign, effect, approval and dialled number. Closed and archived request/attempt records remain readable under independent grants. Missing or changed origin, older context, invalid provider evidence, unavailable native history or expired policy remains unresolved for clinic reconciliation. No local patient queue or recovery map is added.

The current clinic-admin-approved owner-file policy must admit this provider/source/automation principal. The owner rereads policy around asynchronous grants and retains exact native source, provider, credential and current-permission fences. Contact history export has a new independent decoded `readContactLineage` grant; the old current-contact reader's public evidence and grant requirements remain unchanged. Full history includes closed/archived reviews within the existing bound, followed by a fresh complete rescan and current head/reconsent checks.

## One restrictive native decision

The decision uses the original preallocated v3 IDs and records `consent: unknown`, `doNotCall: blocked`, both follow-up and sick-day purposes and no reconsent approval. It identifies the clinic-approved automation principal. Someone answering a shared phone is not treated as proof that the patient personally withdrew consent.

`ClinikoOutboundDncRecords` retains responsibility for independent read/write/producer/restore grants, same physical account-wide 180-request budget, exact native acknowledgement and permanent opaque one-use exclusion. Concurrent observers cannot append twice. A known accepted acknowledgement survives later permission withdrawal. Lost acknowledgement consumes the action conservatively; a cold observer can discover an exact committed decision in native history. An uncertain write with no native decision cannot be replayed. The approval ID is never consumed as an effect.

Finding the same recorded stop in historical lineage returns `existingDecision` and does not append it again after a later independently clinic-approved reconsent. Any conflicting reuse of the reserved IDs is refused. Head observations are not atomic compare-and-swap; concurrent native forks remain subject to existing fail-closed lineage validation.

## Remaining integration requirements

This is a conditional native recording component. It does not implement raw Twilio/Vapi report authentication, number-wide suppression across patients or locations, unresolved-stop admission, positive contact authority, call launch, capacity release or reconsent. Provider/clinic-owned durable stop truth must keep future calls blocked even while native writing is unresolved or uncertain. Patient-scoped native lineage alone cannot establish a shared-number guarantee. No default listener, cron, outbound activation, schema or local phone/hash ledger is introduced.

Concrete runtime adapters must supply trustworthy durable observations and compose a complete suppression/recovery path before activation. Abby's clinical verification, contact/clinic grants, speech and confirmation gates remain independent. See [runtime responsibilities](OUTBOUND_RUNTIME.md) and [current evidence](EXECUTION_PROGRESS.md).

## Concrete Twilio native recovery

The [signed native recovery owner](TWILIO_OUTBOUND_STOP_RECOVERY.md) supplies the concrete Twilio + Abby stop observation from an actual signed callback and independently granted MAC-authenticated clinic-owned report history. It binds the original pre-send digest and actual physical call, then invokes this same conditional DNC owner. Its focused source, complete strict serving build and emitted PostgreSQL/privacy checks pass locally; cloud qualification follows. Report grant loss remains fenced through decision preparation. Completed status alone is insufficient, positive stops may precede closure, and missing/no-stop evidence leaves holds intact. Actual speech/report production and an approved receiver composition remain separate; no route/default activation is added. The independent complete-source number-wide reader/guarded launch still owns cross-patient suppression and unresolved-contact admission.

The [optional signed HTTP receiver](TWILIO_OUTBOUND_STOP_RECEIVER.md) composes that concrete native recovery in the actual ingress server request lifetime. It is locally qualified separately and does not activate the CLI, supply a speech producer or release holds. Ordinary historical observers retain their original contract; private signed recovery is explicitly configured under independent native grants.


The [optional positive speech-stop producer](TWILIO_OUTBOUND_STOP_SPEECH.md) now
connects the actual assembled outbound turn to native report production and the
same DNC recovery engine. Its selected profile is approved before speech, and
the owned disconnect tail awaits independent bounded native retention after
voice closure.62 focused source controls and strict fixture types pass;
whole strict/667 serving build,129 existing voice controls and9 emitted SQL/privacy cases also pass. Publication/cloud qualification follow. This supplies no no-stop
coverage, complete all-call/provider finality, hold release or clinical authority.
Report/recovery/receiver foundations through PR565 are normally merged with all
exact-head cloud jobs green; actual merged-main qualification is separately
recorded in EXECUTION_PROGRESS.md.
