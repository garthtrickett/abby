# Stripe sandbox provider rehearsal

Observed on 24 October 2026 using the owner's privately supplied test-project
key. The initial account, unpaid, paid and signed-reference observations exercised
the normally merged PR595 source. The final compiled HTTP exercise uses the
locally qualified snapshot-compatibility candidate. These are provider
diagnostics, not an activation or complete payment-lifecycle pass.
No key, account/Session/charge ID, checkout/receipt URL, webhook secret, event
body, patient details or real clinic record is included here.

## Actual observations

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

The private native side of these rehearsals was simulated. Real clinic-owned
financial record types, current grants, producer trust, fee/recipient policy,
native durability, SQL/process-loss/restore composition, receipt delivery and
clinic-observed acceptance retain their own requirements. The first signed
event exercise establishes reference verification and a version incompatibility.
The compatibility candidate passes 56 source controls, both metadata guards,
whole strict TypeScript and the serving build containing 744 outputs; 743 outputs remain
byte-identical to the qualified parent and only the handoff output changes.
Six private offline compiled-route controls cover valid HTTP 200, altered-signature
HTTP 400, native/pending/current-grant HTTP 503, unsupported profiles, absent
delivery and one-use reports. The subsequent actual Stripe/compiled HTTP exercise
passes within its declared simulated-native scope. Review, exact-head CI,
normal delivery and independent resulting-main CI remain separate requirements.

Stripe's [test-card instructions](https://docs.stripe.com/testing) apply only to
sandbox keys. Keep the test secret in the existing private project configuration,
not in source or shell arguments. An exclusive started or uncertain rehearsal
report must be reconciled before any new attempt; missing output grants no
second payable creation. Ordinary engineering continues independently of
real-clinic activation and human acceptance.
