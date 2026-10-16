# Proposed Stripe payment lifecycle contract

Status: engineering proposal,16October2026. Stripe was selected by the owner.
The pending-work owner below is a recommendation awaiting selection, not an
accepted clinic record schema or permission to enable real payment workflows.
The protocol/read adapter in draft475 is qualified separately; the full payment
lifecycle remains unfinished.

## Recommended ownership

Use a dedicated clinic-approved Cliniko financial review/recall type for private
pending payment work. Stripe owns payable Sessions, received money, refunds,
disputes and hosted receipts. Abby keeps only independently random one-use
operational effect IDs and approved non-patient ownership metadata in PostgreSQL.
No patient, appointment, Stripe/event reference, amount, currency, recipient,
intent body or retry payload belongs in that local claim storage.

The alternative is a clinic financial system that already offers a durable
pending-work contract. That would need a concrete adapter and acceptance of its
record fields and permissions. No such system has been identified in Abby.
Avoid assuming a private local deposit database or a hypothetical backend.

## Private provider records

A proposed immutable financial intent binds its random action ID to current
clinic/location/account/mode, exact patient and native booking action/selection/
interval, approved price/amount/currency, requirement/terms version, deadline,
approved recipient and separate effect IDs. These fields remain in the approved
clinic/provider record. Stripe receives only its approved correlation/digest
fields, not the raw review/transcript. Exact bounds/encoding must satisfy the
existing1,000-character recall summary contract; oversized context refuses.

Capture approved post-booking deposit terms before they are spoken. Unknown
requirement is not no requirement, and a changed patient/service/time/policy
invalidates the old quote. This flow does not promise a payment-dependent hold.

A prospective financial review can be durable before a possible booking write;
its existence is not a booking acknowledgement. Automatic payable creation
requires separately retained evidence of the exact acknowledgement observed by
the booking owner plus current financial service permission. If process loss
prevents retaining that evidence, the existing private review remains for staff;
a later matching diary row cannot invent the missing acknowledgement. Optional
financial-record/Stripe/delivery failure preserves acknowledged booking success.

## Effects and recovery

Create one payable Session only after the owner has durably consumed its opaque
effect ID and retained the provider-owned attempt evidence. Unknown creation is
readonly exact discovery/review, including after Stripe idempotency retention;
an absent result/local row never authorizes another payable creation.

The initial provider-owned pending work must remain discoverable by a separately
authorized reconciler. A webhook may acknowledge only after that durable handoff
is established or completed work is proven. A valid signature or local event ID
alone does not establish pending work, financial permission or completion.

Financial status is freshly read for the exact provider account/action/amount/
currency. Delivery and receipt use separate one-use IDs and current approved
native recipients; sender acceptance does not prove mailbox receipt. Missing
receipt/upload/delivery never unpays a received amount. Resending an existing
link is separately authorized and cannot silently create a replacement Session.

Clinical expiry requires current independent clinical authority, the unchanged
exact native target, current approved expiry terms and closed-unpaid financial
evidence. Processing/authorized/unknown money refuses automatic cancellation.
Expire the Checkout Session rather than directly cancelling its PaymentIntent.
An expired Session is not a cancelled appointment. Late payment, uncertain
cancellation or changed native context requires owned review; no restoration,
refund, fee waiver or coverage promise follows automatically.

A restored database cannot revive a one-use effect. Provider attempt evidence
and independently established owner/quiescence/restore admission remain required;
notes, an absent local claim, a released advisory lock or an elapsed lease do not
prove an old sender stopped. Missing evidence denies automatic replay.

## Acceptance still needed

Select the pending-work owner, then qualify its concrete schema/permissions,
pre-booking terms, observed acknowledgement handoff, one-shot creation/discovery,
signed/reordered/duplicate events, exact recipient delivery/receipt, payment versus
expiry/manual-paid races, process loss, restore/quiescence and SQL/backup/public
privacy through the actual host. Clinic approval/configuration, real provider/
sender activation and authoritative CI are separate gates. All13 gaps remain active.
