# Proposed Stripe payment lifecycle contract

Status: financial-work ownership selected by the owner,17October2026. Stripe
and dedicated Cliniko financial reviews are selected. The concrete clinic
record schema, permissions and lifecycle remain engineering/acceptance work;
this decision does not enable real payment workflows.
The protocol/read adapter in draft475 is qualified separately; the full payment
lifecycle remains unfinished.

## Selected ownership

Use a dedicated clinic-approved Cliniko financial review/recall type for private
pending payment work. Stripe owns payable Sessions, received money, refunds,
disputes and hosted receipts. Abby keeps only independently random one-use
operational effect IDs and approved non-patient ownership metadata in PostgreSQL.
No patient, appointment, Stripe/event reference, amount, currency, recipient,
intent body or retry payload belongs in that local claim storage.

The owner selected dedicated Cliniko reviews from the proposed choices. A
second financial system is not a prerequisite. Actual dedicated recall type IDs,
field/content approval, current access permissions and activation remain clinic
configuration/acceptance gates; engineering uses patient-free fixtures.

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

Qualify the selected Cliniko owner’s concrete schema/permissions,
pre-booking terms, observed acknowledgement handoff, one-shot creation/discovery,
signed/reordered/duplicate events, exact recipient delivery/receipt, payment versus
expiry/manual-paid races, process loss, restore/quiescence and SQL/backup/public
privacy through the actual host. Clinic approval/configuration, real provider/
sender activation and authoritative CI are separate gates. All13 gaps remain active.

## Refinement against the existing code

- [Recall writer](../src/cliniko/recall-write.ts) supplies one possible create
  and readonly observation, with a1,000-character summary limit. Its process-local
  attempt set alone is not a durable financial claim. The existing
  [review reader](../src/cliniko/recalls.ts) decodes booking-family envelopes;
  a financial record needs its own strict codec/reader and current permission,
  rather than interpreting existing notes as financial authority.
- The [resend journal](../src/standalone/confirmation-resend-journal.ts) is an
  existing precedent for scoped opaque one-use IDs. Its mail-specific statuses
  are not financial truth. Restore/handoff must retain provider attempt evidence
  and independent quiescence, not reset or expire a possibly used effect ID.
- A prospective intent refers to the intended booking action; a separately
  authenticated acknowledgement citation must retain the exact native created
  target after the owner observes a valid201. If that retention is lost, staff
  owns the durable unresolved review. Automatic collection cannot reconstruct a
  missing acknowledgement from a matching appointment or review checkbox.
- `onBookingAcknowledged` remains an observer of irreversible booking truth.
  Financial failure cannot become a success veto. A later reconciler needs its
  own current clinic financial/service authority, rather than the ended caller's
  verification code or old proof. Clinical expiry has a further distinct grant.
- A manually recalled/edited record is not received-money or fee-waiver evidence.
  Changes pause automatic work until independently inspected under the applicable
  financial contract. Processing or uncertain payment/cancellation never becomes
  an automatic restore, second charge or blind clinical retry.
- Native financial-record/proof/recipient reads and writes must be included in
  the same physical Cliniko account's cost and allocation admission. Stripe's
  separate quota does not add Cliniko headroom; the180-request ceiling remains.

## First financial-intent schema

The prospective `financial-review-intent.ts` codec uses a separate versioned
financial envelope and the action UUID as its recall marker. It binds clinic,
location, native account credential fingerprint, patient, intended individual
or class booking action/selection/interval, Stripe account/mode, approved minor
unit amount/currency, policy/terms versions/deadline, email recipient and five
independent effect IDs (creation, link, receipt, Checkout expiry and clinical
expiry). Email is the initial encoding; real delivery is still
deferred. No new local private table, sender or provider effect is introduced.

The deterministic uncompressed payload must fit the existing1,000-character
summary contract. Only explicit fields, canonical UTC millisecond timestamps,
positive bounded minor-unit amounts and distinct UUIDv4 effect/action IDs are
accepted. Malformed, noncanonical, extra-field or oversized envelopes refuse.
This is prospective context only: no native target acknowledgement, paid flag,
receipt, replay permission or clinical expiry authority can be encoded. A
schema-valid edited record remains untrusted context; parsing cannot establish
immutable history or permission. Separate authenticated observed-acknowledgement
and attempt records, discovery, lifecycle, current permission and restore
admission remain to be implemented and qualified through the host.
