# Stripe sandbox provider rehearsal

Observed on 24 October 2026 using the owner's privately supplied test-project
key. Initial component checks used normally merged PR595 and the subsequent
snapshot-compatibility candidate. [PR596](https://github.com/garthtrickett/abby/pull/596)
then normally merged as `1961e824`; its eight exact-head jobs, four independent
resulting-main jobs and all sixteen raw logs were verified. Subsequent native
rehearsals below used that exact runtime tree and its unchanged 744 serving
outputs. These are scoped observations, not activation or a complete
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

Business-clock expiry has not yet been qualified. A real-time rehearsal must
wait for the captured deadline without changing the clock; an immediate cleanup
POST or a synthetic time advance cannot establish that result. Clinical expiry,
manual-payment/waiver checks and every real clinic approval retain their
independent requirements.

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
manual-payment/waiver policy, composed process-loss/restore, business and clinical
expiry, external sender/inbox delivery and clinic-observed acceptance remain
unqualified. Actual demo record retention and loopback receipt delivery cannot
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
