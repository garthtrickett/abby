# Setting E2E isolation evidence

**Code revision tested:** `b5da9174c2ef80e77a6ad3836a28990e4e87db71`

**Fixture source:** `SCENARIO_MANIFEST.json` version 1.5 and the five mapped synthetic voice files at that revision.
**Capability mode:** synthetic reference/embedded hosts only; automation and booking are exercised in their test-local default, enabled and disabled states. No real clinic route or patient capability is activated.

`npm run test:settings-isolation` runs each mapped voice file alone with one worker, then runs all five with four workers in forward and reverse file order. It checks that every isolated file has a passing case, that neither parallel run has a failure, and that the combined passing count equals the sum of the isolated counts.

| Case | Isolated result | Parallel forward | Parallel reverse |
| --- | --- | --- | --- |
| E2E-004 knowledge, embedded call | 1 pass | Included | Included |
| E2E-004 knowledge, signed buyer-process call | 1 pass | Included | Included |
| E2E-010 booking toggle | 1 pass | Included | Included |
| E2E-018 automation toggle | 1 pass | Included | Included |
| E2E-074 emergency write stop | 1 pass | Included | Included |
| **Total** | **5 pass, 0 fail** | **5 pass, 0 fail** | **5 pass, 0 fail** |

`npm run test:browser -- --grep 'E2E-004|E2E-010|E2E-074' --workers=3` ran five mapped dashboard journeys using three Playwright workers: **5 pass, 0 fail**. The browser configuration enables fully parallel cases, and each journey creates its own local server on an ephemeral port with in-memory state.

The voice probe uses only the named synthetic tests. E2E-074's PostgreSQL variant is skipped without the isolated PostgreSQL probe flag, so this result does not establish database case isolation. It also does not cover every setting, a signed standalone runner journey, a real carrier call, or clinic activation. Those remain separate A2 and package exit evidence.

## Mapped setting sweep with isolated PostgreSQL — 2026-10-01

**Implementation revision tested:** `daa51120e9081429e39210b9046bef878097f8f9`.

`npm run test:settings-isolation:postgres` starts a disposable PostgreSQL instance and derives its file groups from every current `settingMappings` row in scenario manifest version 1.6. It refuses a setting without runnable evidence, a missing scenario ID, a failed or skipped Node test, a selected ID without a passing assertion, or a different case count in parallel order. Node runs whole files because filtering by a nested test name can silently skip its parent suite. Browser runs the mapped cases with Playwright. Each file runs alone, then Node runs across four file workers and browser across three workers in both forward and reverse file order.

| Target | Files | Alone | Parallel forward | Parallel reverse |
| --- | ---: | ---: | ---: | ---: |
| Node text, composition, voice and signed standalone with PostgreSQL | 10 | 104 passed, 0 failed/skipped | 104 passed, 0 failed/skipped | 104 passed, 0 failed/skipped |
| Browser admin and dashboard | 2 | 9 passed, 0 failed/skipped | 9 passed, 0 failed/skipped | 9 passed, 0 failed/skipped |

The sweep includes knowledge approval, booking and automation toggles, emergency write stop, and Cliniko availability approval, alternatives and time-zone binding. Its signed standalone file runs all 21 provider and transport fault journeys, including database-loss health. An earlier four-worker run exposed a parent-suite timeout before queued E2E-200 cases started; a later isolated run exposed an unbounded database health response. The signed suite now keeps five-case internal concurrency with a 240-second parent limit, and health requests return within a 1.5-second bound while a single underlying probe is in flight. The passing sweep used those fixes; it did not lower file or browser worker counts.

## Host-authenticated admin addition — 2026-10-01

Manifest version 1.8 maps E2E-211 to the availability-approval setting and its policy-changing command. `Abby host identity mapped setting isolation PostgreSQL and browser` completed with exit 0 in 11m02s. The manifest-derived sweep passed 105 Node cases across ten files alone and with four workers in both file orders, plus ten browser cases across three files alone and with three workers in both orders. The added browser case uses a synthetic host session to approve read-only Cliniko availability, then checks absent, staff, foreign-scope, forged-role, identity-provider-failure, mismatched-gateway, wrong-Host and invalid-Origin paths. It does not supply a production identity provider or durable clinic approval workflow.

This establishes file-level order independence for the mapped local cases, not complete whole-call coverage for every setting or carrier behavior. Provider demo-account operations, real clinic authorization, and actual Twilio routing remain separate gates. The tracked work result is `Abby mapped setting isolation after bounded health response` with 5m28s elapsed and exit 0. The full PostgreSQL probe at the same implementation revision passed 762/762 tests with no failures, cancellations or skips.

## Durable admin-to-voice approval addition — 2026-10-01

Manifest version 1.9 maps `E2E-212` to the Cliniko availability approval setting and its read, change and revoke commands. The new case uses a host-authenticated synthetic admin HTTP command path, PostgreSQL approval storage, and a separate signed standalone voice process. It checks approval readback after admin server and database connection recomposition, provisional speech, revocation refusal, anonymous denial, and storage, backup and runner-output canaries.

`npm run test:settings-isolation:postgres` passed on retry: 106 Node cases across 11 files passed alone and with four workers in both file orders; ten browser cases across three files passed alone and with three workers in both orders. `npm run probe:postgres` passed 764/764 tests. The first isolation attempt failed in the existing `E2E-176` database-loss health check when its fetch rejected rather than receiving the expected HTTP 503. That 22-case signed voice file passed on a focused rerun and in all three isolation modes on retry. The cause of the first failure remains undetermined, so this does not establish that the health check is free of intermittent failure under load. These tests use synthetic host sessions, Cliniko and signed local transport; no production clinic identity or carrier call is proven.

The active-call extension of E2E-212 then passed its focused disposable PostgreSQL run and a fresh mapped isolation sweep in 5m53s: 106 Node cases across 11 files passed alone and in both four-worker orders, and ten browser cases across three files passed alone and in both three-worker orders. The admin revokes while the signed stream is open; the admitted call still obtains and speaks provisional times, while the next signed webhook is refused. A stale revocation version returns HTTP 409 before the valid revocation. This verifies the documented captured-policy rule for read-only availability, not immediate termination of an active call.
