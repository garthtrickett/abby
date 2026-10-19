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
