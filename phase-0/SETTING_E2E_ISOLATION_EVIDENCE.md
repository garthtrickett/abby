# Setting E2E isolation evidence

**Code revision tested:** `834d5c4991b21d6d18c6ebddca3dc3bd53d459c7`

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
