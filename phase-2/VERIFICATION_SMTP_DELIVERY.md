# Verification email delivery over SMTP

`SmtpPatientCodeDelivery` supplies the existing `PatientCodeDelivery` port with a
real TLS connection and SMTP submission. It sends only the fixed six-digit
verification message. A deploying clinic must still provision a sender and
mail account, approve its mail retention policy, supply independent patient and
operation permissions, and verify actual mailbox receipt before activation.
No Twilio number is needed to implement or test this adapter.

## Host connection

Construct the adapter in the trusted deploying host and pass it as `delivery`
to `CallerVerificationSession.create`, or the clinical workflow host's
configuration. Read credentials from that host's private secret source. Never
include them in a model prompt, approval record, command argument, browser
configuration or log.

```ts
import { SmtpPatientCodeDelivery } from "../src/standalone/smtp-patient-code-delivery.ts";

const delivery = new SmtpPatientCodeDelivery({
  host: mailAccount.host,
  port: mailAccount.port,
  username: mailAccount.username,
  password: mailAccount.password,
  from: mailAccount.approvedSender,
});
// Pass delivery alongside the current approval, contact, permission and budget
// ports when constructing the admitted call's verification owner.
```

The adapter is optional. The default standalone runner does not choose a mail
account or enable clinical calls. Its recipient comes from the existing fresh
registered-contact read, never from a caller's proposed replacement address.
The SMTP adapter supplies transport acceptance; the verification owner retains
challenge expiry, answer limits, current contact and policy checks, disposal,
the shared clinic budget and operation-bound proof.

## Supported transport

The connection uses implicit TLS, port 465 by default, certificate trust and
hostname verification, and TLS 1.2 or later. AUTH PLAIN must be advertised after
EHLO. Credentials are printable ASCII, at most 128 characters each. Sender and
recipient must already have the application's canonical mailbox syntax. The
client does not negotiate STARTTLS, AUTH LOGIN or SMTPUTF8.

Configuration captures a private immutable copy, including optional public CA
roots supplied by the owner. The whole connection has one deadline, default
five seconds and configurable from 100 to 5,000 milliseconds; caller abort
closes it. Reply lines, multiline replies and buffered input are bounded.
Malformed, unsolicited and inconsistent replies terminate submission.

These protocol boundaries follow [SMTP](https://www.rfc-editor.org/rfc/rfc5321.html),
[SMTP authentication](https://www.rfc-editor.org/info/rfc4954/) and
[SASL PLAIN](https://www.rfc-editor.org/info/rfc4616/). Certificate and connection
controls use [Node's TLS API](https://nodejs.org/download/release/v22.23.0/docs/api/tls.html).

## Acceptance and uncertainty

`send` returns true only after the server accepts the completed DATA message
with 250. This establishes SMTP acceptance, not inbox receipt, caller identity,
patient permission or an appointment outcome. A lost acknowledgement returns
false even if the server received the message. There is no reconnect, replay or
automatic resend. That failed or unknown delivery cannot create a challenge
that the caller can verify.

The message contains the recipient, sender, code and fixed keypad instructions.
It contains no patient name, date of birth, appointment facts or promised expiry.
No message, credential, code or raw SMTP error is logged or stored by Abby.
The external mail server necessarily receives and may retain the message;
clinic provisioning must account for that separate system.

## Qualification

`test/cliniko/smtp-patient-code-delivery.test.ts` runs real loopback TLS and SMTP
with fresh synthetic certificates, account, recipient and message data. It
connects successful submission to the actual caller verification session and
protected Cliniko appointment read. Faults cover authentication rejection,
recipient rejection, unavailable authentication, malformed replies, certificate
identity and trust failure, dropped DATA acknowledgement, caller abort, timeout
and permission denial. Unknown submission cannot verify or resend. Fixtures
destroy sockets and remove their temporary keys at teardown.

The focused command passed 21 tests with zero failures or skips:

```sh
node --test --test-concurrency=4 \
  test/cliniko/smtp-patient-code-delivery.test.ts \
  test/cliniko/caller-verification-session.test.ts
```

This proves local transport and verification composition with synthetic data.
Real sender provisioning, mailbox receipt, accepted clinic policy and deployed
caller routing remain open. Production admission stays on hold.

The final source typecheck and neighbouring regression also passed:

```sh
npm run typecheck && node --test --test-concurrency=4 \
  test/cliniko/smtp-patient-code-delivery.test.ts \
  test/cliniko/caller-verification-session.test.ts \
  test/contract/scenario-manifest.test.ts
```

Result: 22 passed, zero failures or skips. Tracked job `Abby SMTP verification
type and regression gate October 13` completed exit 0; log
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791862804355.log`.
The subsequent manifest 1.149 registration passed its focused contract and
`git diff --check`; it retains 347 scenarios and planned full-call evidence.
Versions 1.147 and 1.148 belong to the separate unmerged clinical runner PR.
