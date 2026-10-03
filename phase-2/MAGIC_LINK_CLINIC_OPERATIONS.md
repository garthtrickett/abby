# Magic-link clinic operations

## Status — 2026-10-03

Local D1/D3 implementation connects the actual standalone Cliniko magic-link application to its existing aggregate and speech-status screens. Two new complete HTTPS browser journeys have focused proof; the final registered-source and parallel gates remain open. No email provider is selected. Messages, catalogue replies and speech reports in these journeys are synthetic.

## Contract

- A confirmed current clinic-admin session discovers `operations.daily.v1` through the restricted dashboard's capability endpoint. It reads seven UTC days from the same PostgreSQL database as authentication and policy. The gateway derives tenant, clinic and location from the current trusted account; query parameters and role headers cannot select another scope.
- Only the existing nine fixed nonnegative counts are returned. Zero is explicitly not proof of service health or staff delivery. No patient, call, task or transcript record is added. Speech status projects only four named checks, a synthetic candidate result and unverified representative-call/release state; private report paths and transcript fields are excluded.
- The admin composition passes its existing host clock into the operational reader as well as catalogue setup. Normal callers still use the default current UTC clock; isolated journeys supply one fixed clock. Session and link expiry remain owned by PostgreSQL time.
- Anonymous users, staff and stale membership cannot read the aggregate or speech endpoint. Owner-file account changes invalidate an existing session even without a directory-version change. A newly confirmed staff session keeps its read-only restrictions. Revocation removes subsequent dashboard access.
- Malformed speech evidence or unavailable operational storage returns a typed failure. Reload removes the table rather than preserving old counts as current. Restored data can be read again. Restart resolves the existing approved session and current counts through a new canonical composition.

The production changes reuse the existing gateway and public status projection: include the already permitted operational schema in the setup capability filter and forward the composition's existing clock to its operational store. No clinical permission, core transition, schema migration, dependency or mail transport is introduced.

## Executable evidence

`E2E-262` in manifest 1.72 maps to `test/browser/magic-link-operations.spec.ts`. It covers actual owner-only directory provisioning, explicit magic-link confirmation, PostgreSQL sessions/counters, generated local HTTPS and the canonical Cliniko handler. Each case owns its database/container, certificate/listeners and account folder. Atomic owner-file replacement exercises current membership rather than injecting an actor or session cookie. Existing TLS/PostgreSQL/browser helpers own teardown.

The positive journey verifies exact table values, discovery, foreign tenant/clinic/location exclusion, restart, malformed speech and an unavailable operational table. It scans database rows and browser/HTTP output for raw login and session secrets, email, transcript, patient and report-path canaries. These are row/output scans; the existing authentication and operational storage suites supply the separate disposable backup evidence. The role journey proves downgrade/revocation, newly confirmed staff denial and a refused staff locale edit. That locale permission case maps the file into the existing manifest-derived setting isolation sweep; complete locale setting/captured-call behavior remains E2E-258.

Initial results are retained:

1. `Abby actual Cliniko magic link operational discovery privacy and role baseline` **failed, exit 1, 51s**: the staff/membership journey passed, while the admin journey reproduced the missing `operations.daily.v1` discovery descriptor. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791010448811.log`.
2. After correcting the filter, `Abby Cliniko magic link advertised aggregate schema current HTTPS privacy and role correction` **failed, exit 1, 2m11s**. Typecheck and five browser journeys passed, including both new cases, but four existing reference login cases could not open the unbuilt `dist/dashboard/app.js`. This command failure is not a passing release. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791010530280.log`.
3. `Abby complete built HTTPS magic link and operational schema regression` **passed, exit 0, 47s**: building dashboard, Cliniko-admin and sign-in bundles before the same four browser files passed **nine journeys** with two workers, no skips, and diff check. Command: `npm run build:dashboard && npm run build:cliniko-admin && npm run build:sign-in && npx playwright test test/browser/magic-link-operations.spec.ts test/browser/magic-link-cliniko.spec.ts test/browser/magic-link-sign-in.spec.ts test/browser/local-cliniko-admin.spec.ts && git diff --check`. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791010689947.log`.

Those focused inputs preceded the new fixed operational-clock wiring and rebase onto registered agent proposals. The final source must pass typecheck, registration/trace/authority contracts, actual PostgreSQL admin composition and browser regression, then the full mapped browser sweep alone and in both existing three-worker orders. It must not inherit a current-source pass from the earlier focused run.

## Remaining external proof

Real mail delivery, approved deployed accounts/recovery and production HTTPS/proxy operation remain open. Source-matched speech reports still govern their own quality gate; these synthetic status fixtures cannot pass it. Standalone patient follow-up stays unavailable until the clinic accepts its Cliniko workflow. No provider mutation, real carrier call, scheduled alert acceptance or staff-delivery proof is claimed by an aggregate view.
