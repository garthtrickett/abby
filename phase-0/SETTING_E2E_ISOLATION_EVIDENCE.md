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

This establishes file-level order independence for the mapped local cases, not complete whole-call coverage for every setting or carrier behavior. Provider demo-account operations, real clinic authorization, and actual Twilio routing remain separate gates. The tracked work result is `Abby mapped setting isolation after bounded health response` with 5m28s elapsed and exit 0. The full PostgreSQL probe at the same implementation revision passed 762/762 tests with no failures, cancellations or skips.
