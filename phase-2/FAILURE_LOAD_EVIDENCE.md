# D4 synthetic failure and load exit

**Status:** Number-independent engineering exit met for the current read-only standalone voice runner and the reference host's uncertain-effect contract. This is synthetic evidence on Abby `main` at `255cb33cb9786f148bd0c1a27c56be4caf72a8fa` on 2026-10-01. It is not a carrier-capacity, real Cliniko outage, or enabled standalone patient-write claim.

| Risk | Whole-path evidence | Observed boundary |
| --- | --- | --- |
| Concurrent calls, duplicate ingress, cross-tenant routing and shared budget | Signed `E2E-198`; `E2E-156/157/159/160`; parallel budget tests | Eight calls across two synthetic clinics keep their own greeting and provisional result. Duplicate webhooks and a second stream do not create another call owner; a ninth call gets direct-contact fallback after the 48-read budget. Provider traffic is GET-only, and database/backup caller canaries are clear. |
| Provider 429, 5xx, failed fetch and timeout | Signed `E2E-174/175/207/208` | No provisional time, booking claim or write follows an untrustworthy read. The caller receives the direct-contact fallback where speech delivery remains possible. |
| Stale catalogue and approved scope | Signed `E2E-193/204/209/210` | Changed business/type relationships or business time zone fail closed; the next call uses the current approved primary after a versioned change. |
| Speech/transcription failure and database loss | Signed `E2E-173/176/196` | Failed greeting or transcription does not reach Cliniko; database loss closes the active stream and fails health. This proves local failure behavior, not a carrier fallback call. |
| Process loss and restart | Signed `E2E-177/197/213` | A killed runner drops the old stream; the replacement admits a new signed call from the persisted read-only approval. It does not replay the old call or claim its outcome. |
| Possibly sent host effects | Memory and PostgreSQL `uncertain host write` voice tests; PostgreSQL `restart after possible send` and `restart after possible staff-task send` tests | An uncertain result speaks pending review without a booking claim. The authorized reference ledger retains exact-key reconciliation and does not send another write after restart. The standalone Cliniko runner has no enabled patient write or staff task. |

The current-main focused D4 sweep passed **40/40** tests with four Node file workers. It used a disposable PostgreSQL server and migrated its base database before running `test/voice/standalone-voice-concurrency.test.ts`, `test/voice/standalone-voice-failures.test.ts`, `test/voice/bounded-health-check.test.ts`, `test/storage/postgres-cliniko-request-budget.test.ts`, and `test/cliniko/shared-read-budget.test.ts`. The separate focused reference-effect run passed **4/4** tests with `ABBY_LEDGER=postgres`. Both commands and their prerequisites are reproducible from the repository root:

```sh
bash scripts/with-postgres.sh bash -c 'node scripts/migrate.ts && node --test --test-concurrency=4 test/voice/standalone-voice-concurrency.test.ts test/voice/standalone-voice-failures.test.ts test/voice/bounded-health-check.test.ts test/storage/postgres-cliniko-request-budget.test.ts test/cliniko/shared-read-budget.test.ts'

bash scripts/with-postgres.sh bash -c 'node scripts/migrate.ts && ABBY_LEDGER=postgres node --test --test-concurrency=2 --test-name-pattern="uncertain host write|restart after possible send|restart after possible staff-task" test/voice/voice.test.ts test/storage/postgres.test.ts'
```

The migration and `ABBY_LEDGER=postgres` are required. An earlier ad hoc run without migration failed five budget tests because the disposable base database had no budget table; a separate reference-only run without `ABBY_LEDGER=postgres` exercised memory fixtures and could not read the expected PostgreSQL call rows. The corrected commands passed. These setup failures do not establish a provider or product failure.

The declared eight-call target measures functional isolation, not latency or maximum capacity. A real carrier call, number-level fallback ringing, real provider tail latency, and a deployed clinic route are still unverified. Standalone patient-specific writes and follow-up remain unavailable under the separate C1/C2/B3 gates, so this exit cannot prove that Cliniko accepts exactly one mutation or recovers an uncertain live write after process loss.
