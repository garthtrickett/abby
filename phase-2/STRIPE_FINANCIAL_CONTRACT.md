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

## Exact financial-review read adapter

The dedicated reader requires current clinic financial-owner permission for its
configured location, native credential fingerprint, business, dedicated recall
type, Stripe account/mode and exact recall/action references. The trusted host
supplies this permission; record notes cannot establish it. Permission is
checked before quota admission, after quota admission and after reading the
record. Every native GET claims the host-supplied physical-account budget; this
adapter creates no separate budget or additional headroom.

One exact native GET validates record/self/patient/type links, financial intent
family/action and configured ownership. It returns transient private context
only, including native workflow flags. Recalled, archived and validly edited
notes remain context, never received money, immutable history, observed booking
acknowledgement, location authority or an effect permit. A404/unknown read has no
creation/retry meaning. There is no list/latest fallback, writer, payment route
or local private table. Current permission/discovery/observed-acknowledgement
and attempt handoff through the actual financial host remain to be qualified.

The native [recall contract](https://docs.api.cliniko.com/openapi/recall) supplies
record links, notes, dates and workflow fields; it permits updates and does not
supply financial/booking acknowledgement evidence. The1,000-character summary
limit is Abby’s existing writer contract, not a newly asserted provider limit.

The reader shares a bounded body-owning module with the existing Stripe
readers/webhook verifier. It snapshots bytes, caps storage, yields for endless
empty chunks, retires its own reader and bounds dependencies that ignore abort.
It leaves a pre-locked foreign reader untouched. Native HTTP/body/permission
errors expose only bounded failure kinds. Constructor configuration projects
approved ownership fields rather than copying arbitrary private properties.
Local interface validation passes61 focused checks and full TypeScript on
sourcef71f863d. This does not qualify actual financial-host permissions or
lifecycle/privacy/recovery. No real provider was accessed.


## Producer-authenticated booking observation candidate

`financial-booking-capture.ts` prepares against an exact active financial-intent
record through the current-owner reader, comparing the complete canonical
expected intent before the native final availability/consent checks. Its
individual and class methods delegate to the real native writers and supply the
acknowledgement callback themselves. A nominal returned acceptance without that
callback, a lost response, or a later matching diary inspection cannot create an
observation. Both existing clinical permission/current callbacks remain required.
The financial intent's `booking.actionRef` binds the native provider marker/class
action UUID, not the separate core host mutation key.

The callback produces a bounded separate note containing the intent record,
canonical intent digest, financial and native action UUIDs, exact created target,
observation time and producer key reference. The record marker is also signed.
It uses injected Ed25519 `KeyObject`s and domain-separated canonical bytes with
Node's built-in [sign/verify API](https://nodejs.org/download/release/v22.15.0/docs/api/crypto.html#cryptosignalgorithm-data-key-callback).
No key provisioning, environment activation or dependency is added. The trusted
financial owner must independently supply its currently approved producer public
key; neither a key reference nor a key obtained from notes establishes trust.
Verification binds the whole expected intent, including location/account/mode,
terms, recipient and all effect IDs, and refuses edits or cross-record reuse.

This is producer-observation capture and verification only. The signed candidate
is transient private provider-bound content; it must never enter local journal,
model, transcript, public response, diagnostic log or outbox payload. Signing
failure or a later wrapper error preserves an already validated native booking.
Preparation is not a clinical grant, and a signature is not current financial
permission, received money, immutable provider history, durable retention or a
replay permit. The helper is not wired to the serving host or checkout creation.
A consumed in-process capture is not a durable once-only barrier across restart.

Durable Cliniko observation retention, current financial-host authorization,
pre-booking approved fee capture and intent creation, one-use financial effects,
producer/restore quiescence and the actual composed booking-to-payment workflow
remain open. Missing retained acknowledgement stays unresolved for staff; diary
matching must not reconstruct it. Clinic record/key/permission provisioning and
real Stripe/sender activation remain separate acceptance gates.


## Opaque financial-effect barrier and transfer candidate

`FinancialEffectBarrier.claimOnce` is a durable submission barrier only. The
PostgreSQL implementation atomically consumes an independently random UUIDv4
before external work; a repeated claim returns false, and scope/owner mismatch
or unknown storage outcome supplies no retry permission. No reset, expiry,
reassignment, completion or received-money API exists. The table retains only
tenant/clinic/location, opaque effect UUID, non-patient owner-configuration
binding and barrier audit time. The owner binding must identify approved
clinic/account/producer configuration; it must never hash patient context,
intent bodies, recipients, provider references or a financial result.

Migration049 installs the existing portability write/truncate guards. The
strict separate staff-work record carries original UUID/binding/time through
mapped import and later transfers, preserving original logical scope. Both
resend and financial families share one canonical section digest, checked in
full rather than validating one projection against the whole section. Unknown
fields, financial/private content, duplicate IDs, unmapped ownership, occupied
targets, missing/extra consumed rows and changed retained metadata refuse.
Repeated staging, re-export and actual cutover reconciliation inspect current
rows; a cached receipt cannot repair or hide missing barrier history.

A fresh journal claim takes the tenant import/freeze lock and checks audited
import history. An ID known to have been consumed by that import can never be
recreated after relational-row loss. Invalid retained metadata blocks new claims.
A restored snapshot can still omit activity newer than the snapshot: local
absence is not evidence of an unused effect. Independent current financial-owner
permission, exact provider records and admitted/quiesced producer state remain
mandatory before any external effect. This barrier does not create pending work,
authorize a checkout, retain an observed booking receipt or activate payments.

The composed standalone transfer test exposed a prior target-readiness mismatch:
minimal policy JSON was compared with a full reference-host policy. Import and
readiness now share the exact existing minimal storage projection. It is allowed
only for a verified minimal source, rejects extra capability fields and preserves
the existing full representation for embedded targets. No clinical/financial
permission, source approval, stop or cutover authority is weakened.


## Native financial-record retention and exact observation read candidate

`ClinikoFinancialRecordRetainer` can retain a strict prospective intent and a
separate producer-authenticated booking observation in the dedicated financial
recall type. Each POST claims its independently random record action UUID through
a matching durable barrier before native quota and dispatch. A duplicate or unknown
claim never sends. Its non-patient owner binding derives only from configured
logical scope, business, native credential fingerprint, financial recall type,
Stripe account/mode and approved producer public-key identity. Private intent,
patient, recipient, record references and results never enter that binding.

The trusted financial service supplies current `allows`, independent
`producerAdmitted` and synchronous `current` guards. The final synchronous guard
must check current grant generation/lifetime immediately before I/O; an ended
caller's proof is not financial-service permission. POST revalidates permission
and producer admission after the durable claim/quota wait. Exact observation GET
requires current financial read authority before, after quota and after body
processing; it does not admit an effect producer. No default allow/admit path exists.

The explicit clinic-approved review date participates in the permission query.
A UTC payment deadline is not silently converted to a local due date. Intent
creation refuses future creation times or an expired fee deadline before native
dispatch. Retaining an already observed booking fact is not suppressed merely
because financial terms later expire; it still proves no collection permission.

Only an exact validated201 yields a retained-record receipt: native self/patient/
type links, action marker, exact canonical notes, review date, active flags and
ordered timestamps must match. The [native recall API](https://docs.api.cliniko.com/openapi/recall)
exposes create and exact GET; it supplies no business/location field to substitute
for independent clinic ownership permission. A signed observation cannot overwrite
or masquerade as its own source intent record. No update, retry, list/latest fallback,
financial action or sender is exposed. Read/write share the configured physical
Cliniko budget and whole-operation15s/1MB owned-response bounds, including
noncooperative dependencies and late headers. The summary limit remains Abby's
contract, not an asserted vendor maximum.

A fresh owner can read an exact retained observation and verify the independently
approved producer key, original intent digest/ref, action UUIDs and exact native
target. Recalled/archived flags remain context, not payment or completion. Native
unknown fields and raw notes are not returned by this observation API. A lost
retention response, caller ending, role withdrawal or quota exhaustion does not
erase an already acknowledged clinical booking; the prospective native intent
remains available for independent financial review. Missing-reference discovery
and automatic reconciliation are not supplied by an exact-ref read.

The shared financial configuration/instant parser was extracted without changing
the existing intent reader's public imports or bounds. PostgreSQL barriers now
expose only a pure scope/owner `matches` check in addition to the existing claim.
The native adapter rejects a mismatched/unscoped barrier and malformed claim
results. No pending payload, patient/provider reference, email, money, note or
private key is persisted locally by this adapter.

These are scoped client/cohort results, not an activated financial host. The
actual serving/fee-consent integration, provider-owned queue discovery, independent
producer/restore admission, original native versus mapped local owner binding,
real process-loss composition, Stripe creation/webhook lifecycle, delivery,
receipt and expiry remain to qualify. Clinic record/field/permission/key approval
and real provider/sender activation are still separate acceptance gates.


## Bounded native financial-work discovery candidate

`ClinikoFinancialWorkDiscovery` reads a bounded created-time window from the
native recall collection, including archived records. It uses only documented
created-time/archive filters, ascending native IDs and count-driven pagination;
it never follows provider pagination links or invents a recall-type/business
filter. The native contract is documented in the [Cliniko recall API](https://docs.api.cliniko.com/openapi/recall)
and [filtering reference](https://docs.api.cliniko.com/).

Because recalls have no native business/location field, scanning requires an
explicit currently valid account-wide read grant. Exact selected financial
records and cited source intents require separate current record grants; neither
an unsigned note nor an authenticated producer citation supplies ownership or
permission. The clinic must approve the dedicated type and actual broad-read
permissions before activation. No deploying permission source is invented here.

A scan is at most one hour, five100-row pages,500 total native rows,50 selected
financial records and50 exact source/intent lookups within one15-second lifetime.
Every request claims the same configured physical account budget. Each owned body
is bounded to1MB. Stable count, exact page size, strictly increasing unique IDs,
canonical native links, dates/flags and timestamps are required. Unknown financial
schemas, mismatched scope/account/patient, changed listed intents, invalid proof,
ambiguous observations and shared one-use IDs refuse the whole window. No partial
result, missing-record claim, retry admission or cached success is returned.

Producer citations are first authenticated without assigning scope, then bound
to an independently authorized exact native source intent, including a source
outside the listed window or archived by staff. Full producer signature/digest,
financial/native markers, patient and individual-versus-class target-kind binding
remain required. The exact reader's optional archive-inclusive mode still checks
the canonical self link; its default API/behavior remains unchanged.

Results are private `pairedContext` or `intentContext`, with native workflow flags.
An unmatched intent does not mean an acknowledgement is absent: a citation may
fall outside the scanned window. A window result is an observation of bounded
reads, not an atomic snapshot, global queue completion, immutable obligation,
producer/restore admission, financial effect permit or money truth. A later
worker must reread and independently authorize exact current context. This
candidate adds no scheduler/cursor, local private queue, database rows, writes,
Stripe creation, sender, public route or serving fee-consent integration.


Discovery qualification: frozen078cf64 work1792210491174 passed107/107 focused
checks and full TypeScript, zero skips/failures/cancellations. Its37 new cases and
precise limits/results are recorded in [execution progress](EXECUTION_PROGRESS.md#bounded-native-financial-discovery-qualification).
This is a provider-port fixture qualification, not an activated scheduler/worker,
real provider read or serving financial-consent proof. No later money, delivery,
webhook, expiry or restore/producer admission is inferred from it.


## One-shot checkout owner candidate

`ClinikoStripeCheckoutOwner.createOnce` joins exact financial intent/producer
observation reads, independent current collection/producer admission, a durable
opaque effect exclusion, Cliniko-owned attempt retention and one Stripe Session
POST. It is a trusted financial-owner command, not a caller route or a scheduler.
Actual serving fee/recipient/contact-purpose approval and separately played
financial consent remain required; clinical yes and a signature do not provide
these grants. Concrete clinic/producer/restore authorities are mandatory ports,
not default deployment permission.

Before consuming the checkout effect, the owner verifies the configured Stripe
account and completes an independently authorized patient-filtered native review
scan, including archived records and the30-second clock allowance. Existing
attempts refuse creation even if local claim history was lost. The new patient
scan uses the documented patient filter and the existing500-row/five-page/
50-selected/50-exact/15-second/1MB limits across the whole selected interval;
ordinary account-window discovery retains its one-hour limit. Incomplete,
malformed or unauthorized history never becomes a clean absence or send permit.
Independent producer/cohort/restore admission still cannot be replaced by a scan,
expired lease, missing record or restored database snapshot.

The checkout effect UUID is durably consumed before any possible external
creation. A separate random attempt UUID is consumed before its Cliniko POST.
The new canonical attempt family binds exact intent/digest, observation citation,
native target, effect, canonical request digest and provider creation range.
Native attempt retention must receive an exact acknowledgement. Lost/nonexact
attempt retention prevents Stripe dispatch; all consumed IDs remain consumed.
Source intent/observation and permissions are reread after retention. No local
patient, native/Stripe/event reference, amount, recipient, request/response body
or pending/retry payload is stored. Existing approved ownership metadata and
independently random effect/attempt UUIDs remain the only local claim content.

Stripe receives one fixed-amount hosted card Session, an explicitly clinic-approved
generic label/public return URLs, opaque action/effect correlation and an intent
digest. No patient/native record reference, transcript or email is inserted.
Account/mode/API-version binding and a fixed idempotency key are required;
automatic tax, adaptive pricing and promotion codes are disabled. Exact creation
acknowledgement checks identity/mode, action/effect/digest, total/currency,
open-unpaid state, expiry/creation time and the provider checkout URL. It proves
creation only, never money or email delivery. If read permission is withdrawn
after an exact acknowledgement, `createdWithheld` preserves that truth without
disclosing the checkout URL. Errors after dispatch remain uncertain, with no
automatic POST replay even after Stripe idempotency retention.

The adapter pins the documented2025-06-30.basil contract and supports explicitly
approved card payment. Other methods/version changes need qualification. Fixed
clinic deadlines outside Stripe's30-minute/24-hour creation limits refuse; they
are never silently extended/clamped. The persisted possible-creation range covers
from admission minus clock allowance through the latest creation permitted by
the fixed expiry. It is not a client-timeout absence proof. Subsequent readonly
Stripe reconciliation must cover that whole range in bounded windows, bind exact
current account/action/amount/currency and treat incomplete/unknown results as
review. A provider attempt note is unsigned context, not a receipt or permission.
[Stripe creation](https://docs.stripe.com/api/checkout/sessions/create?api-version=2025-06-30.basil)
and [idempotency](https://docs.stripe.com/api/idempotent_requests) define the
provider contract; local one-use history and independent admission retain the
stronger no-replay rule.

This candidate adds no webhook acknowledgement/durable event handoff, link/receipt
sender, auto expiry/cancellation, public financial endpoint, approved fee
presentation or real-provider activation. Those remain the next gap11 lifecycle
work, followed by gaps12/13 and combined/clinic acceptance. All13 gaps remain active.


Checkout-owner qualification: frozenad04a9c work1792211462184 passed178 focused
checks and full TypeScript, zero skips/failures/cancellations. This includes real
PostgreSQL concurrent-owner, killed-worker recovery and all-column privacy
cases, with synthetic provider ports. See [execution evidence](EXECUTION_PROGRESS.md#one-shot-stripe-checkout-owner-qualification).
It does not qualify a real provider, actual serving financial consent or complete
webhook/delivery/receipt/expiry/producer-restore lifecycle. All13 gaps remain active.

## Private financial consent before individual booking

The optional financial preparation config is now connected to the actual
`ClinikoBookingHost` and approved individual booking composition. It requires a
clinic policy returning an exact required deposit or an explicit versioned
`notRequired` assessment, independent financial source/record/producer grants,
a matching approved Ed25519 key, a shared physical Cliniko rate budget and an
independently owned financial-retention signal. Unknown requirements refuse.
This is an internal composition port, not a new public activation setting or
an approved clinic fee policy.

Before any clinical proposal the host retains a prospective intent once in
Cliniko. The private keypad path reads the exact amount/currency, fixed deadline,
recipient/contact purpose and approved terms in bounded parts. Each part needs
a fresh continuation digit after its actual played receipt. Every private
prompt retains its existing20-second deadline and each digit's owner work stays
bounded25seconds; no deadline is increased to accommodate a long readback.
Parts contain at most160 text characters/24 words plus continuation instructions;
an unusually long individual word/address refuses rather than silently dropping
content. Initial spoken currencies are GBP/AUD/NZD/USD/EUR/CAD; other display
currencies need qualification. These text bounds do not prove real TTS timing.
A final played instruction precedes a separate acceptance digit. Failed,
interrupted, repeated-receipt, stale-selection, withdrawn-authority and early
queued digits cannot accept. Declining any part does not book or create checkout.

The caller then says “continue booking” and separately confirms the ordinary
clinical proposal. A financial answer never creates a clinical action. Private
media is discarded before ASR/model handling. Raw DTMF arrival captures an opaque
in-memory owner/quote/phase token before semantic queuing; a queued request for
the next part cannot become final acceptance. The transport's per-chunk gate
also closes on financial authority/selection loss. SAM retains only blank notice
presentations with opaque IDs, without money, recipient, readback or consent.

After an exact native booking ACK, the producer signs observation v2 into a
separate Cliniko review. Its financial consent binds the complete ordered
readback digest, final opaque presentation reference/play time, separate
acceptance reference/time and exact intent. The producer attests completion of
all parts; the last presentation reference alone is not a transcript or financial
grant. Existing v1 booking signatures remain supported and domain-separated.
Financial signature/retention errors cannot erase an acknowledged appointment.
Financial retention can continue after the caller ends using the independent
service signal. No financial async preparation is inserted between final native
availability and the booking POST.

The checkout owner's independent collection authority can inspect the fully
verified v2 booking observation. A signature, clinical yes, unplayed text,
expired grant or discovery result still cannot grant collection, contact,
producer/cohort/restore authority, money truth or email delivery.

Qualification covers the real host, SAM/review/worker path, actual private
VoiceSession playback marks/per-chunk gate, actual signed Twilio wire arrival
admission, and real PostgreSQL booking-to-fixture-Stripe exclusion/privacy.
Those are separate focused cohorts, not a single complete signed serving
journey or real phone/provider/mail acceptance. Configured financial class
booking currently refuses instead of bypassing financial requirements; its
native cohort and full catalogue/intake serving journeys remain to be completed.
Webhook durable handoff, complete creation-range reconciliation, delivery,
receipts, financial/clinical expiry and producer/restore composition remain
unfinished. All thirteen gaps remain active.
