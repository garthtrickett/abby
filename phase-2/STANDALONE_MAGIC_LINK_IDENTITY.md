# Standalone clinic sign-in: email magic links

## Status and scope

Implementation plan for the number-independent D-14 identity gap. Email magic links are the current recommendation following the owner's question about needing a separate identity provider. The owner confirmed that no email delivery service is selected; local work uses an injected synthetic delivery port. No hosted identity vendor or email delivery vendor is selected. The explicit dashboard request-handler composition and authentication primitives are in implementation. This file does not claim a complete implemented browser sign-in, delivered mail, deployed TLS or production identity evidence.

Standalone sign-in establishes an account. The existing trusted actor gateway remains responsible for clinic/location scope and roles. After acquisition, the buyer resolves the authenticated actor using its own session and membership system; Abby's domain commands, voice sessions and Cliniko adapters do not depend on this login implementation.

## User flow

1. The clinic administrator opens Abby and requests a link with their email address.
2. The response has the same public wording for a recognized account, an unknown address, throttling or delivery failure. There is no public signup or automatic clinic membership.
3. A recognized, currently authorized account receives a short-lived link. The configured clinic origin supplies its destination; request headers cannot replace that origin.
4. Opening the link shows an explicit account confirmation. A GET or an email scanner's preview must not consume the token or create a session. The confirmation POST must pass the login page's CSRF and exact Origin checks.
5. Successful redemption atomically consumes the token and creates a new session. The browser receives an opaque cookie and opens the existing lit-html admin dashboard.
6. Every dashboard request resolves current membership. Expired sessions, removed users and changed membership cannot retain the previous role or clinic scope. Logout revokes the current server-side session.

Do not require the email link to open in the browser that requested it. The confirmation page must identify the account being entered and require a deliberate action; no silent account switch or automatic login on link load is permitted.

## Ownership and ports

| Interface | Input | Output and owner |
| --- | --- | --- |
| `AdminDirectory.findByEmail` | Normalized address, transient | Existing opaque user reference and membership revision, or no account; trusted provisioning only |
| `AdminDirectory.findByRef` | Opaque user reference | Current trusted `HostActor`, account email and membership revision, or revoked/missing; never derived from request role/scope fields. Email stays in authentication/account-confirmation only. |
| `MagicLinkDelivery.send` | Recipient and fixed-origin link, transient | Typed accepted/unavailable result; no account or clinical authorization |
| `MagicLinkStore.reserveRequest` | Keyed recipient/client/global hashes | Shared bounded request budget before account lookup or mail; production limits and window are storage-owned |
| `MagicLinkStore.issue` | Token digest, user reference and exact membership digest | Durable single-use challenge with storage-owned expiry; raw token and recipient are absent |
| `MagicLinkStore.redeem` | Token digest and new session digest | Atomic consume plus session creation, or typed invalid/expired/used/storage failure |
| `MagicLinkStore.readSession` | Cookie digest | Opaque user/revision plus bounded lifetime, or no session; current directory membership is checked separately |
| `MagicLinkStore.revokeSession` | Cookie digest | Idempotent logout; no client claim of success when storage is unavailable |
| `MagicLinkIdentity.resolveActor` | HTTP request cookie | Current exact actor or no identity; plugs into the existing dashboard boundary |
| `MagicLinkIdentity.handle` | Sign-in/confirmation/logout HTTP request | Bounded public login response or delegation to the authenticated dashboard |

Keep token/session protocol and trusted account lookup outside `src/core`. Compose identity routing with an explicit dashboard request handler; avoid mutating a server's listener array or duplicating the admin command HTTP dispatcher. Preserve the current host-authenticated server and owner-only local rehearsal APIs.

## State and security contract

- Use cryptographically random 256-bit link and session secrets. Persist only SHA-256 digests. Link lifetime is 10 minutes; session idle limit is 30 minutes and absolute limit is 8 hours. Inject time only at the test boundary; production storage enforces expiry with server time.
- Single use and session creation are one transaction. Concurrent redemption has exactly one winner across connections/processes. No replay becomes a second session, including after process restart.
- Secure, HttpOnly, SameSite cookies are limited to the configured HTTPS origin and path. Loopback HTTP is an explicit isolated test exception; production cannot select it by forwarding headers. Do not put session secrets in JavaScript storage or URLs.
- Put the emailed link secret in the URL fragment. Remove it from visible browser history before submission. Auth pages use no-store, a restrictive CSP and no-referrer; no third-party scripts or analytics receive it.
- Bound request bodies and validate exact shapes. Refuse foreign or missing POST Origins, untrusted Host, open redirects, query-controlled return locations and self-declared roles/clinics. Bind confirmation CSRF to its anonymous browser cookie; rotate to a fresh session secret on successful authentication.
- Throttle recognized and unknown addresses with the same rules, before mail. Use shared bounded rate-limit state for multiple processes; do not retain raw recipient/IP values or emit them in logs. Delivery failures invalidate the issued challenge and do not retry email automatically.
- Store only opaque administrator references, membership revisions, token/session digests, scope where necessary, expiry and bounded throttle metadata. Keep administrator email in the trusted account directory and mail transport boundary. No patient data, Cliniko credentials, call state, transcripts or appointment details enter authentication storage.
- Trusted provisioning grants and revokes membership. Possession of an arbitrary mailbox or a Cliniko API key grants no Abby clinic access. The stored membership digest covers the directory revision, email, actor reference, role and exact tenant/clinic/location. Recheck it at redemption and on every request; changed account fields invalidate pending links and existing sessions even if the directory forgot to advance its revision.
- Add migrations and regenerate actual Kanel/kanel-kysely types. Buyer imports exclude login challenges, sessions and throttle state; target identity remains buyer-owned and target preferences still require their existing readiness review.

The token and session rules draw on [OWASP emailed-token safeguards](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) and [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). The password-reset source supports token handling; it is not a recommendation to turn a password reset into automatic login.

## Required executable evidence

1. A complete local HTTPS browser journey requests a link, observes the synthetic delivery, confirms the actual emailed link, edits a permitted clinic setting through the existing gateway, reloads durable state, logs out and loses access. No self-declared actor is injected in this browser path.
2. Unknown email, removed account and foreign clinic membership send no mail and cannot obtain authority. Public request responses do not reveal account existence. A staff account cannot write admin settings; anonymous users cannot inspect them.
3. Expired, malformed, replayed and concurrently redeemed links cannot create another session. PostgreSQL tests use independent connections and a new composition after restart. A GET/scanner preview leaves the valid link redeemable.
4. Expired/revoked sessions, changed membership, forged cookie, fixation attempt, foreign Host/Origin, missing login CSRF and attacker-controlled return destinations are refused. Pending links cannot preserve a revoked privilege.
5. Mail timeout/rejection, database failure before issue or during redemption, logout failure and rate-budget exhaustion return truthful public behavior. No session is claimed without an atomic committed result. No retry duplicates delivery or redemption.
6. Database, backup, logs, errors and ordinary dashboard responses exclude raw link/session secrets, recipient addresses, Cliniko credentials and patient/call data. The intentional protocol disclosures are the emailed link to its recipient, the session cookie to the authenticating browser, and account email to a valid link holder on explicit confirmation. These must not leak into unrelated responses or telemetry. Synthetic mail fixture memory is explicitly the delivery boundary, not durable Abby storage.
7. Register identity scenarios and real executable files in the manifest. Run new files alone and in the existing parallel Node/browser orders without skips, then the affected broad release gates. Do not lower concurrency, extend deadlines or skip failures to obtain a pass.

## External proof still required

A real sender/domain and delivery service, trusted clinic account provisioning, public HTTPS deployment, owner-reviewed account recovery/revocation workflow and delivery to an authorized test mailbox remain separate evidence. Local synthetic mail proves the application contract, not mailbox delivery or production readiness. No actual email is sent as part of local development.

## Foundation evidence — 2026-10-03

- `Abby magic link explicit dashboard handler composition proof` completed successfully in 5m52s: `npm run typecheck`, six existing HTTP listener/Origin/identity checks with four Node workers, and `git diff --check`. The composition now exposes a request handler without changing host authorization behavior or manipulating a server's existing listeners. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790997397508.log`.
- `Abby magic link identity primitive authorization and secret boundary proof` completed successfully in 1m53s: typecheck, seven authentication-service checks with four Node workers, zero failures/skips, and diff check. They cover explicit inspection without consumption, a preprovisioned account, replay, concurrent redemption, logout, unknown/invalid/agent/throttled requests, expiry/revocation, exact membership changes, delivery rejection and stored-secret exclusion. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790997754736.log`.
- These are foundational service tests against a deterministic in-memory port fixture. They do not prove PostgreSQL atomicity, process restart, HTTP/cookie/CSRF routing, browser sign-in, the final parallel identity sweep or actual email delivery. Production persistence, UI and the full composed journey remain to implement.
- `Abby magic link startup origin and hung delivery deadline refinement proof` completed successfully in 6s: the authentication file now passes nine checks with zero failures/skips, including malformed/insecure/expanded/port-zero startup origin refusal and a mail port that ignores abort. Its five-second deadline resolves without retry and removes the challenge. Command: `node --test --test-concurrency=4 test/text/magic-link-identity.test.ts && git diff --check`. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790998104814.log`. Final typecheck and the full identity release remain pending; no complete identity feature is published yet.
- `Abby magic link migration rollback and actual Kanel generation` passed in 20s: fresh schema migration, down/up of migration 041, actual Kanel/kanel-kysely generation and diff check. Its three tables contain only digests, opaque administrator references, bounded lifetimes and keyed throttle counters. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790998253541.log`.
- `Abby generated PostgreSQL magic link store initial typecheck` passed in 5m01s. The store queries use actual generated tables and brands; there are no handwritten generated rows. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790998543102.log`.
- `Abby PostgreSQL magic link single use rollback expiry and shared budget proof` passed in 36s: seven migrated PostgreSQL checks plus the nine authentication-service checks, zero failures/skips. They include independent connections, an independent Node process, concurrent single use, transactional rollback on failed session insert, link/idle/absolute expiry, recipient/client/global request limits and rejection of raw identifiers. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790998739505.log`.
- `Abby magic link actual PostgreSQL expiry during owned row lock proof` passed in 9s: the focused check observes the actual database lock wait while the credential remains valid, releases it after expiry and verifies neither the link nor idle session is revived. Expiry is checked after row ownership, with the existing two-second statement timeout unchanged. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1790999059688.log`.
- The latest storage test additions still need final typecheck and whole-file/parallel release coverage. Login HTTP/cookie/CSRF routing, the lit-html sign-in page, trusted directory provisioning and complete browser sign-in remain to implement. No identity feature has been published.
