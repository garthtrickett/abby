# B1 Cliniko catalogue and connection evidence

**Engineering exit:** met for the current read-only standalone adapter on 2026-10-01 at Abby `0281824bc1a5213b2a3dc8c8b4277771e6bf51bd`. This proves the local contract in [B1](../NO_TWILIO_NUMBER_WORK_PLAN.md), not activation for a real clinic.

The authenticated host supplies the tenant, clinic, location and clinic-admin actor. The catalogue reader validates its configured Cliniko credential with bounded metadata reads, and the setup service binds a selected business, practitioner, appointment type, policy version and number route to a versioned read-only approval. Candidate lists and inspections grant neither booking nor patient-specific request authority. Each new call rechecks the approved route, credential fingerprint, policy and Cliniko eligibility.

| B1 requirement | Current evidence |
| --- | --- |
| Credential and business connection | `ClinikoCatalogueReader.businesses` returns a complete bounded list or a typed denial, rate limit, unavailable or malformed result. `C-LIVE-23` passed against the authorized demo account: one business, one practitioner, two types, one inspected combination and nine bounded metadata GETs through the current adapters. Its selected combination was unavailable because that business had online booking disabled. |
| Business, practitioner and type mapping | `E2E-227` lists practitioner and type candidates for a selected business through clinic-admin commands and the lit-html panel. The demo list adapters returned one business, one practitioner and two types. Exact `inspect` re-reads resource and relationship eligibility, names, online flags, archive state and business time zone before approval. Suggestions alone do not approve a choice. |
| Scope and authorization | `E2E-194/195/214/227` deny agent, staff, malformed and foreign-scope setup requests before protected catalogue reads or approval. The local owner listener requires its owner-only credential and exact POST origin. PostgreSQL approval reads isolate clinic scopes. |
| Freshness, drift and revocation | `E2E-191/193/204/209/215/216` and setup tests reject short relationship pages, changed business/type eligibility, time-zone drift, credential rotation and stale metadata. Route and policy versions are rechecked around provider reads; call-time revalidation refuses stale approval. The stored approval uses optimistic versions, survives a new database connection, and revocation blocks later calls. |
| Privacy boundary | Candidate replies contain only clinic metadata and a credential fingerprint. Fake-provider patient and secret canaries are absent from command/browser output and the isolated PostgreSQL approval rows. Patient action and request modes remain `unavailable`. |

## Reproduction and results

- `node --test --test-concurrency=4 test/cliniko/catalogue.test.ts test/cliniko/catalogue-setup.test.ts test/cliniko/catalogue-command-gateway.test.ts`: **22 passed**.
- Disposable PostgreSQL approval and signed-runner tests: **5 passed**. The migration and tests must share one disposable database session; an unmigrated database fails because the approval table is absent. Reproduce with:

  ```sh
  bash scripts/with-postgres.sh bash -eu -c '
    node scripts/migrate.ts
    node --test --test-concurrency=4 \
      test/storage/postgres-cliniko-approval-store.test.ts \
      test/voice/standalone-admin-approval-voice.test.ts \
      test/voice/standalone-credential-rotation.test.ts
  '
  ```
- `npm run build:dashboard` and `npm run build:cliniko-admin`, then `npx playwright test test/browser/availability-setup.spec.ts test/browser/local-cliniko-admin.spec.ts --workers=2`: **8 passed**. Rebuild both ignored browser bundles after a source change; a stale bundle made the first audit attempt time out before the new button appeared.
- `ABBY_LIVE_CLINIKO_EVAL=1 node --env-file=.env --test test/live/cliniko-catalogue.test.ts`: **1 passed**. This read-only demo check printed only counts, selection status and reason codes. No raw IDs, patient data, provider responses or credentials were saved in the repository.
- The preceding feature commit also passed `npm test` with **492 passed, 26 PostgreSQL-only skips** and the focused availability browser file with **7 passed**.

## Remaining decisions and limits

The demo business currently disables online booking, so this audit did not activate a caller-facing route. A participating clinic must choose the exact location and route, approve its versioned wording and policy, and rehearse its staff process. A production host must supply and deploy a real clinic identity and role source; the local Basic-token listener is an owner-only setup tool. Cliniko credential ownership for another tenant, real carrier routing, and another clinic's account behavior are unverified. None of this evidence enables patient disclosure, staff handoff or booking.
