# Stripe sandbox provider rehearsal

Observed on 24 October 2026 using the owner's privately supplied test-project
key. Initial component checks used normally merged PR595 and the subsequent
snapshot-compatibility candidate. [PR596](https://github.com/garthtrickett/abby/pull/596)
then normally merged as `1961e824`; its eight exact-head jobs, four independent
resulting-main jobs and all sixteen raw logs were verified. Subsequent native
rehearsals initially used that exact runtime tree and its unchanged 744 serving
outputs. The later configured-server checkpoint uses PR599/main08325d8b and
its 744 outputs; only the native memo writer differs from the earlier runtime.
These are scoped observations, not activation or a complete
payment-lifecycle or clinic-acceptance pass.
No key, account/Session/charge ID, checkout/receipt URL, webhook secret, event
body, patient details or real clinic record is included here.

## Initial component observations

| Exercise | Observed result | Scope |
| --- | --- | --- |
| Account binding | Two real account GETs succeeded through bootstrap and Abby's current reader. | Account identity only; no financial-object mode or payment proof. |
| Unpaid Checkout | Current owner created one test Session; same and fresh owners refused duplicate creation. The current reader observed open/unpaid. Fixture cleanup expired it once and a fresh read observed closed/unpaid. | Twelve direct Stripe requests; simulated Cliniko records, grants, producer and one-use barrier. No clinical expiry or cancellation. |
| Hosted test payment | One fresh Session was paid through Stripe's hosted form with its published test card. Abby independently read the exact completed Session, succeeded PaymentIntent and captured charge, and retained a valid hosted receipt reference. | Nine direct Stripe requests plus the browser's form traffic. The amount was AUD5.00 (500 minor units), synthetic fixture data rather than a clinic deposit policy. No real money, receipt-content inspection, email delivery or native settlement. |
| Signed expired event | An official checksum-verified Stripe CLI listener forwarded one actual expired-Session event to a temporary loopback test sink. The current verifier authenticated the exact reference under explicitly selected `2026-09-30.endive`; changing the bytes failed verification. | Twelve direct Stripe requests plus CLI transport. The unchanged Basil financial profile refused the authentic different-version event. The sink returned 503 and acknowledged no durable financial work. |
| Compiled financial HTTP handoff | One actual CLI-delivered Endive event passed through the emitted production handler and handoff. HTTP 200 followed the independent reference/pending grants, exact native intent/producer-observation/attempt discovery and both fresh Stripe/native rereads. | Sixteen direct Stripe requests, one Checkout creation and one fixture expiry; the final read confirmed closed/unpaid. The three native records, producer trust, grants and one-use barrier were simulated in memory. This qualifies that declared Stripe/HTTP composition, not real Cliniko durability, SQL restore, a public endpoint or an operational consumer. |

Two earlier hosted-form attempts ended without a payment result. Each Session
was independently observed unpaid, expired once and observed closed/unpaid.
Diagnostics on the second attempt located the stop before Pay submission. Using
the button's accessible name and ordinary enabled-state waiting then allowed
the successful test. No challenge was bypassed or payment submission retried.
All owned browser contexts and listener processes were closed. Terminal test
objects remain in the sandbox for audit; closure does not mean record deletion.

## Subsequent native and PostgreSQL rehearsals

These exercises used the existing Cliniko demo account, one owned synthetic
patient/booking family at a time, actual production caller/gateway and financial
owners, actual native HTTP and isolated PostgreSQL effect barriers. The physical
native budget remained 180; direct Stripe requests were also bounded. Independent
demo-only grants, caller verification and playback were explicit substitutions.
They do not establish real clinic fee/recipient/manual-payment/waiver authority,
producer/restore admission, staff acceptance or acoustic quality.

| Exercise | Observed result | Scope and limits |
| --- | --- | --- |
| Native booking and unpaid Checkout | Separate financial and clinical confirmations preceded an acknowledged Cliniko booking and signed native financial observation. The actual owner retained its native Checkout attempt, created one sandbox Session and refused duplicate creation. Fixture-only expiry was followed by a fresh closed-unpaid read. | 114 native requests plus four fresh read-only cleanup requests; twelve direct Stripe requests. Immediate fixture expiry does not qualify the business deadline or clinical cancellation. |
| Native signed HTTP handoff | One authentic raw Endive CLI event and its identical duplicate reached the emitted handler and actual native pending-work handoff. Tampered bytes returned 400; withdrawn current permission returned 503. The handoff introduced no native mutation or SQL effect claim. | 121 native requests plus four fresh cleanup reads; twenty direct Stripe requests, with CLI-internal traffic unmeasured. The original harness exited unsuccessfully after it treated CLI runtime metadata as immutable and could not verify database cleanup. Independent checks reconciled cleanup; the original failed result remains failed. This is scoped behavior evidence, not a fully green harness or public-ingress qualification. |
| Native paid consumer and receipt | A fresh admitted demo call produced one acknowledged booking, signed financial context and one sandbox Checkout. One hosted test-card submission was independently observed as a completed Session, succeeded PaymentIntent and captured charge with a receipt reference. Finite actual polling consumers sent one link and one receipt through the actual TLS SMTP adapter. A fresh consumer refused a duplicate receipt. | 159 native requests plus four fresh cleanup reads; 44 direct Stripe requests, with browser form traffic unmeasured. Twelve private preparation controls included seven isolated SQL/TLS cases and observer-restoration checks. Guarded SQL privacy canaries passed. Mail went only to an isolated loopback server with a synthetic recipient. No external inbox, receipt-content inspection or real-money claim follows. |
| Real-clock unpaid deadline | One new admitted demo booking and sandbox Checkout used a 32-minute quoted deadline. The original expiry owner refused early expiry with zero effect claims. After 1,903,185 ms of actual wall/monotonic waiting, Stripe was already expired/unpaid; the original and fresh expiry owners observed it closed without another write. | 118 native requests plus four fresh read-only cleanup requests; fourteen direct Stripe requests. Zero Stripe expiry POSTs, zero native expiry-attempt POSTs and no clinical cancellation. Twenty-six preparation controls included five isolated SQL cases. The public booking setting was restored before the long wait. This qualifies observation of automatic expiry at the actual deadline, not dispatch of an explicit expiry POST or independent clinical expiry. |

The first composed paid run observed received payment but failed before observed
receipt SMTP acceptance. Its native receipt attempt exists; its broad failure
label initially conflated missing retention with missing SMTP submission. Read-only
investigation preserved that result. Improved private reporting separates native
retention, original-owner outcomes, delivery invocation/acceptance and cleanup;
its diagnostic wrappers return the original methods' exact results and restore
their descriptors. The later run used a new exclusive fixture, not a replay of
that consumed payment. Its payment, source and receipt-URL snapshots stayed
consistent. This pass does not identify the first failure's cause or weaken any
fresh-context, exact-payload or no-replay check.

Post-run read-only checks saw no active fixture patients, retained the two reusable
public review types and observed the original public booking setting restored.
Owned database IDs, names and socket directories were independently absent;
browser contexts, local mail servers and escaped scopes were closed. Sandbox
payment objects remain for audit. These observations concern completed fixtures;
they are not authority to remove other records or rerun uncertain effects.

The separate real-clock rehearsal used actual UTC and monotonic elapsed time,
without advancing a clock, a provider Test Clock or immediate fixture expiry.
Its owner observed the automatically expired unpaid Checkout after the captured
deadline; a fresh owner also observed it closed without writing. SQL privacy checks passed,
and independent cleanup checks found all six owned preparation/provider databases
and socket directories absent. All 744 serving outputs and source pins remained
unchanged. The early refusal and automatic closed-state observation do not qualify
the real-provider path that explicitly dispatches an expiry POST after the deadline.
That path, independently authorized clinical expiry, manual-payment/waiver checks
and every real clinic approval retain their separate requirements.

## Snapshot and request versions

Checkout creation and fresh Stripe REST inspection use `2025-06-30.basil`.
The sandbox CLI reports and delivers snapshots as `2026-09-30.endive`. Stripe
[versions event payloads separately](https://docs.stripe.com/webhooks/versioning)
and an [event's version stays fixed](https://docs.stripe.com/api/events/object).
Changing an API request header cannot relabel an already created event.

The handoff source now permits either of those two explicitly configured
snapshot profiles while keeping Basil REST reads. Each configured verifier
accepts only its exact version; unknown versions, mismatched account/mode,
altered signatures and withdrawn grants still refuse. Existing configurations
are not switched automatically. This does not change the Stripe account's
default API version or create a Dashboard event destination.

CLI development delivery is not a deployed public webhook qualification.
The first test sink verified a reference but deliberately did not return 200 for
financial work. The subsequent compiled HTTP rehearsal returned 200 only through
the actual handoff under its declared synthetic native grants and records.
A production acknowledgment still requires the independently authorized real
native pending handoff and fresh two-provider reinspection described
in [the financial contract](STRIPE_FINANCIAL_CONTRACT.md#raw-webhook-handoff-to-existing-native-pending-work).

## Remaining qualification

The initial component checks simulated native records and exclusion; the
subsequent declared demo rehearsals used actual Cliniko records and PostgreSQL.
Current real clinic grants, producer/restore admission, fee/recipient and
manual-payment/waiver policy, explicit deadline expiry dispatch and clinical
expiry, external sender/inbox delivery and
clinic-observed acceptance remain unqualified. The separately completed
configured-provider demo restore below retains synthetic grants and a private
demo controller; it supplies no clinic-approved restoration authority. The real-clock automatic-expiry
observation above does not close those separate paths. Actual demo record retention and loopback receipt delivery cannot
close those separate requirements. The first signed
event exercise establishes reference verification and a version incompatibility.
The compatibility candidate passes 56 source controls, both metadata guards,
whole strict TypeScript and the serving build containing 744 outputs; 743 outputs remain
byte-identical to the qualified parent and only the handoff output changes.
Six private offline compiled-route controls cover valid HTTP 200, altered-signature
HTTP 400, native/pending/current-grant HTTP 503, unsupported profiles, absent
delivery and one-use reports. The subsequent actual Stripe/compiled HTTP exercise
passes within its declared simulated-native scope. PR596 review, exact-head CI, normal delivery and independent resulting-main CI
were subsequently verified; that delivery does not activate the runtime or
qualify the remaining provider/clinic lifecycle.

Stripe's [test-card instructions](https://docs.stripe.com/testing) apply only to
sandbox keys. Keep the test secret in the existing private project configuration,
not in source or shell arguments. An exclusive started or uncertain rehearsal
report must be reconciled before any new attempt; missing output grants no
second payable creation. Ordinary engineering continues independently of
real-clinic activation and human acceptance.

## Subsequent Checkout process loss and restored state

One fresh real Cliniko-demo/Stripe-sandbox rehearsal killed the original source Checkout worker after the parent received its response but before the owner received an acknowledgement. An earlier full SQL snapshot was restored into a distinct owned target. The target creation claim was absent before and after recovery; actual native possible-attempt history refused a second Checkout or native attempt. The original physical native180 budget stayed live and was never restored. Full SQL snapshots and provider context stayed in memory. Independent inspection and fixture-only expiry closed the known unpaid test Session without fabricating the killed owner's acknowledgement. The run used 109 native requests plus four fresh cleanup GETs and eleven direct Stripe requests. All seventeen owned preparation/provider databases, public booking restoration, zero active test patients and two retained public review types were independently verified. No card, message, clinical cancellation or business-deadline expiry was exercised. This source qualification worker uses synthetic grants/setup time; it does not prove configured-serving or clinic restoration approval.

Two separate synthetic-provider cases now exercise the existing emitted configured voice-serving entry and its actual financial consumer. The original listener/consumer is SIGKILLed before creation acknowledgement, a full preclaim SQL snapshot is restored into a distinct host database, and the cold configured host observes native history without another Checkout or a replacement local claim. In the complementary case, deliberate loss of the in-memory fake's native attempt plus the missing restored claim still cannot authorize creation: fresh producer admission is withdrawn and actually checked. No cold native attempt, claim, Checkout, money or mail work follows. A third physical-account budget database remains live and is never restored; each host also retains its own actual SQL limiter. Full SQL and worker-output privacy and preservation of unrelated legitimate opaque claims pass. Twelve owned databases across both original failed fixtures and both passing cases were independently removed. The two initial fixture results remain failed; only the second failure was traced to cold startup before prospective read bindings were corrected. These two synthetic configured-host cases cannot be combined with the separate real-provider source-worker result to claim a real-provider configured-serving journey or clinic-approved quiescence/restore admission.


## Configured-serving recovery with actual demo providers, 24 October 2026

A new exclusive family exercised the actual emitted `serveClinikoVoice` entry and financial consumer against Cliniko demo and Stripe sandbox. It used the normally qualified PR599/main `08325d8b` 744-output graph through a pinned private demo controller. The controller permits only this demo namespace, sandbox mode and loopback serving; caller verification, playback, policy/producer and recovery-read grants remain explicit synthetic substitutions. Production serving artifacts were unchanged.

The original configured server reached one real Checkout response, held only in the parent before owner acknowledgement. Its process was actually SIGKILLed and its loopback listener disappeared. A full preclaim SQL snapshot was restored into a distinct owned target. The cold configured server opened its own listener, rediscovered native attempt history and independently read provider money under the separately declared recovery grant. It created no second Checkout or native attempt, and the target creation claim stayed absent before and after recovery. An unrelated legitimate opaque claim survived. The original third physical native-180-budget database was never restored, while each host retained its own actual SQL limiter. The original creation acknowledgement remains unknown.

The run used 113 native and 18 Stripe requests: one Checkout, one native Checkout attempt and one independently verified fixture-only expiry of the known unpaid Session. Full unfiltered SQL and worker-output privacy passed, with no private retry files. Owned native cleanup and public booking restoration passed. An independent root audit found all three database IDs/names/socket folders absent and rehashed all 1,148 source/proof inputs plus the current 744-output graph. Node was capped at 512 MiB with no swap; the three external databases each retained 512 MiB/no-extra-swap, one CPU and no network. Database peaks were not measured. This expiry is fixture cleanup, not business-deadline or clinical expiry dispatch.

The exact composed setup separately passes 7 offline controls and 11 entry controls, including consumed state before credential reads and refusal to retry an uncertain executor. Initial fake-native metadata and positive producer-check expectation failures remain preserved. The corrected positive uses the original history-based no-replay invariants; the distinct missing-histories negative actually checks fresh producer refusal and permits no cold money/delivery continuation. No quota, deadline, snapshot or privacy assertion was widened. These controls are separate from the single actual provider attempt.

Private aggregate provenance is `abby-native-serving-restore-v4/root-provider-audit-v1.json`, report SHA256 `4895796358e36652336d7fd6911b644f1c7660c0055b5d6dcba0f4010498a1d7`, under the existing private state home. This new observation directly qualifies the stated configured-provider demo journey; the older source-worker and simulated-provider proofs retain their own scopes. Real clinic producer/quiescence/restore approval, manual-payment/waiver authority, external delivery, staff, carrier/acoustic and activation acceptance remain open.


## Native waiver attempt and read-only precision diagnosis, 25 October 2026

One separate Cliniko-demo family acknowledged its booking and native financial
observation, then made one unsigned waiver-draft POST and one signed seal PATCH.
Its private fixture stopped at `waiverSealUncertain` before the production waiver
reader ran. The attempt remains failed/uncertain: 76 native requests, one Stripe
account GET, zero Checkout/payment/expiry operations and zero native archives.
Its public booking configuration was restored, SQL privacy passed and the owned
database ID/name/socket directory were independently absent. The test records
remain retained for review. A separate 48-byte Ed25519 signing credential was
persisted, synced and reloaded before possible writes and remains owner-only.
No existing staff notes, external messages or clinical cancellations were changed.

A separately qualified read-only inspector then made exactly three own-family
GETs and no mutations or Stripe requests. The stored canonical signature and
exact intent/waiver-record binding verified; the current list and fresh record
agreed. This record's `updated_at` has no fractional seconds and falls 5 ms before
the signed approval. The original acknowledgement is not recreated. At this
later observation the decision was expired; its clock was not rewound and no
current approval, replay or cleanup authority was granted. The inspector's
separate database was independently absent after termination.

Twenty-seven fixture/key/entry/composed-SQL controls preceded the failed attempt;
five distinct diagnostic controls preceded the read-only inspection. These are
separate scopes, not a green native waiver lifecycle. Source regression then
reproduced three whole-second failures. The [narrow correction](STRIPE_FINANCIAL_CONTRACT.md#native-waiver-record-time-precision-25-october-2026)
passes 76 source checks, whole strict and 744 emitted outputs locally;743 outputs
match the qualified parent. Publication, actual corrected-provider qualification,
clinic issuer/supersession authority, invoice/manual-payment mapping, staff and
activation acceptance remain open. The earlier successful memo and configured
restore rehearsals keep their original scopes.

Private provenance remains under `abby-native-waiver-rehearsal-v1` in the existing
state home: failed report SHA256 `a4249c8b71c957ca6f5f5c483f5ce84d52f435494335fdb64d4affac71ef82c5`; read-only report SHA256
`6ea35299a57cd36272e6971c8ff1dabb9087df71ce90ac4ebc62718b2787b356`. Independent assessments are `root-provider-audit-v1.json` and
`root-inspection-audit-v1.json`. The failed report and retained namespace are not
rewritten by the later source correction.


### Corrected private preparation and integrated SDK, 25 October 2026

A new, separate rehearsal family is qualified only offline: fifteen fixture
controls, six composed disposable-PostgreSQL cases, ten durable key/one-shot
controls and ten source-selected entry controls pass in distinct scoped runs.
An independent audit confirms a direct CLI invocation refuses to launch. The
six databases and temporary synthetic key directories are independently absent;
no actual new signing key was provisioned, project credentials read or provider
called. These 41 controls and the separate CLI refusal do not establish a real
native waiver lifecycle or delivery attestation. An initial missing-helper
preparation and a later red-case wrapper assertion failure remain failed
historical evidence; the paired green and narrow source delta retain their own
scope. The original uncertain family's records and credential remain untouched.

The same production reader and changed test bytes are now locally integrated
on PR600's normal `cdef6262` parent. Fresh whole strict and 744 outputs pass,
with only the waiver reader different from that parent and 743 exact. Parent
independent main/root qualification, corrected SDK review/delivery and an
explicitly rebound provider entry are still required before a new actual trial.
Private preparation provenance is `abby-native-waiver-rehearsal-v2` under the
existing state home; independent results are `root-offline-result-v1.json`,
`root-sql-result-v1.json` and `root-entry-result-v1.json`. These do not change
any original failed-provider verdict, expiry, cleanup or clinic authority.
