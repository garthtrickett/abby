# Standalone magic-link identity: maintainability review

## Scope — 2026-10-03

Direct review using `thermo-nuclear-code-quality-review` of the local authentication foundation and HTTP/UI/Cliniko composition changes on `codex/abby-magic-link-identity`. This is a maintainability review with focused executable evidence; it does not replace final broad/parallel release gates or establish real mail delivery and production deployment.

## Resolved issues

1. **Preserve the existing authorization dispatcher and typed startup results.** Expose the existing dashboard request handler, prepare it with `magicLinkDashboardIdentity`, then compose public sign-in around it. The Cliniko composition returns its privacy/storage/configuration failures intact. No listener-array mutation, cloned gateway dispatcher or core-specific login condition is required. Real startup and existing host/Origin tests cover the boundary.
2. **Own asynchronous request work explicitly.** A public email request completes before account lookup/delivery. One application-owned queue bounds accepted work to twenty requests and four workers, catches failures, discards pending requests at shutdown and awaits active work. The refined test verifies the capacity itself and shutdown separately. Mail timeout and storage-owned rate limits are covered independently; no email address is queued durably.
3. **Keep membership authority at a trusted boundary.** The owner-file adapter and service share exact account validation. The configured Cliniko composition rejects foreign tenant/clinic/location accounts even if an injected directory supplies them. An exact membership/origin digest invalidates stale links and sessions after account changes. No public signup, request-supplied role or Cliniko credential authenticates the administrator.
4. **Reuse TLS and prove the actual composition.** Extend the existing HTTPS fixture with owned application cleanup instead of duplicating its proxy/certificate lifecycle. A fresh disposable PostgreSQL fixture avoids accessing an inherited database. The browser opens an actual synthetic emailed link, confirms it and edits the real standalone dashboard; no test injects a session or actor into that path.
5. **Handle repeated link navigation at the frontend boundary.** A browser failure exposed a fragment-only navigation retaining the previous document. Fresh confirmation initialization clears the bearer fragment before inspection. The regression verifies a lost committed redemption cannot replay or produce a success claim. Core commands and existing setting components need no login-specific branches.

## Conclusion and remaining gates

No substantive structural finding remains in this direct pass. Login policy stays outside the clinical core, PostgreSQL queries use actual Kanel/Kysely generated types, and no changed production file crosses the 1,000-line threshold. Authentication primitives, directory, HTTP protocol, database store and frontend each have a distinct owner. The optional host sign-out link is validated navigation configuration, not domain authentication logic.

Focused evidence is recorded in [the sign-in contract](STANDALONE_MAGIC_LINK_IDENTITY.md): twenty-nine Node/PostgreSQL checks, six HTTPS browser cases and the later twenty-six-check registration/capacity/typecheck run, all without skips. Earlier failed browser evidence is retained with its passing correction. The registered-source broad regression and whole-file parallel isolation still need to pass before initial publication. Real delivery transport, sender/domain, authorized accounts/recovery ownership, HTTPS/proxy deployment and mailbox proof remain external gates.
