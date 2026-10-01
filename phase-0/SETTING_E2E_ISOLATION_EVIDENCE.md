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

## Signed process restart addition — 2026-10-01

Manifest version 1.10 adds E2E-213 for a new signed call after abrupt runner process loss. The failure-path fixture now observes both runner processes and scans all call IDs it opened, including the new call after restart. The focused signed-runner file passed 23/23 tests. `npm run probe:postgres` passed 765/765 tests with no failures, cancellations or skips. The fresh `npm run test:settings-isolation:postgres` sweep passed in 6m09s: 107 Node cases across 11 files passed alone and in both four-worker orders; ten browser cases across three files passed alone and in both three-worker orders. The first focused attempt used a synthetic 10:00 clinic slot with keypad "today" after that local time had passed; switching the restart case to keypad "tomorrow" made the fixture independent of the test host's time of day. This is new-call recovery evidence, not interrupted-call replay or carrier fallback delivery. The earlier one-off E2E-176 health fetch rejection remains unexplained.

## Local Cliniko admin listener addition — 2026-10-01

Manifest version 1.11 maps E2E-214 to the Cliniko availability approval setting. The actual loopback admin process uses a dedicated owner credential and exposes only availability setup and settings read routes; the browser bundle contains only the setup panel. The new PostgreSQL case verifies Basic challenge and denial, exact Origin, an authenticated approval read after listener restart, revocation, and token/key exclusion from isolated rows, backup and process output. The browser case verifies inspection, approval, reload, revocation, a filtered capability list, a denied booking write route, and patient-text exclusion.

`npm run test:settings-isolation:postgres` passed with 108 Node cases across 12 files alone and in both four-worker file orders, and 11 browser cases across four files alone and in both three-worker file orders. The tracked run was `Abby restricted local admin mapped setting isolation` (6m02s, exit 0). `npm run probe:postgres` passed 766/766 tests with no failures or skips; `npm run test:browser` passed 22/22. Typecheck, scenario-manifest contract and `git diff --check` also passed. The process fixture uses synthetic Cliniko and a disposable database. The owner token authenticates a local setup rehearsal; it does not establish the clinic's real identity, agreement to patient-facing behavior, or a carrier route.

## Cliniko credential rotation addition — 2026-10-01

Manifest version 1.12 adds E2E-215 to the Cliniko availability approval setting. A browser case approves under synthetic credential A, restarts its setup composition under credential B with the same stored approval, and sees an explicit reapproval-required status. It then reapproves and sees a matching status. A separate denied-catalogue case leaves the stored approval visible but says connection and route readiness cannot be checked. The signed process case makes a provisional call under A, restarts the runner under B against the same disposable PostgreSQL database, receives HTTP 503 before a stream or Cliniko read, reapproves through the authenticated admin command route, and makes another provisional call on the already-running B process. The runner makes GET requests only; caller, call IDs and both keys pass row, backup and output scans.

The first mapped isolation run failed in the existing E2E-208 fixture: under the new 13-file four-worker load, one synthetic runner did not become healthy within its 15-second startup window. Both the new file and the existing 23-case failure file had passed alone. The fixture now waits at most 30 seconds for local process startup and fails immediately if the child exits; no worker count or behavior assertion was reduced. A four-file, four-worker reproduction passed 97/97, including E2E-208. The final `npm run test:settings-isolation:postgres` run passed 109 Node cases across 13 files alone and in both four-worker orders, plus 12 browser cases across four files alone and in both three-worker orders (`Abby credential rotation final mapped setting isolation`, exit 0). `npm run probe:postgres` passed 767/767 before the test-only startup-window correction, and the final full browser suite passed 23/23. These synthetic results do not prove live Cliniko key rotation, clinic identity/sign-off or carrier admission.

## Seven-day availability setting addition — 2026-10-01

Manifest version 1.19 maps `availability.sevenDay.enabled` to E2E-199. The signed standalone voice cases now cover omitted/default, explicit-off and approved-on settings. The default and off routes ignore keypad 3 and keep a later keypad 1 read to one clinic-local date. The approved route can make one seven-date read and speak only a provisional result; an enabled provider 429 yields a direct-contact fallback. A route flag and greeting mismatch still refuses startup.

`npm run test:settings-isolation:postgres` passed in the tracked run `Abby seven-day setting mapped PostgreSQL isolation` (8m28s, exit 0). It passed 111 Node cases across 13 files alone and in both four-worker file orders, plus 12 browser cases across four files alone and in both three-worker orders. The added cases use synthetic signed traffic, fake Cliniko responses and disposable PostgreSQL. They do not prove a real carrier call or clinic approval.

The first full `npm run probe:postgres` run passed 791/792 cases but cancelled the existing E2E-171/E2E-218 startup and retention case at its 60-second test timeout under full-suite load; it had no assertion failure. That test starts several deliberately invalid runner processes before checking startup pruning. Its health fetch now has a 1.5-second bound and its overall allowance is 120 seconds; the assertions remain unchanged. The focused disposable-PostgreSQL file passed 2/2, and the final full `npm run probe:postgres` passed **792/792**, with zero failures, cancellations or skips (`Abby seven-day setting final PostgreSQL probe`, exit 0). `npm test` passed typecheck and 472 memory cases with 22 PostgreSQL-dependent skips.

## Cross-mode agent conformance addition — 2026-10-01

**Implementation revision tested:** `72e71e86bfc0a8677f44ea425b43df8f5d674673`.

Manifest version 1.20 maps E2E-222 to the booking setting and write stop. One shared text/core command sequence now runs against strict transient standalone and an authorized embedded reference host with a durable call ledger, using separate disposable databases. It checks role and scope denial, the standalone `unavailable` mode despite an enabled booking setting, exact embedded confirmation before one write, emergency stop before a second write, and different call-state persistence. The standalone database and backup pass caller, patient, proof and call canary scans.

`npm run test:settings-isolation:postgres` passed in `Abby final cross-mode mapped PostgreSQL isolation` (6m41s, exit 0): 112 Node cases across 14 files alone and in both four-worker orders, plus 12 browser cases across four files alone and in both three-worker orders. The new conformance case also passed its focused disposable-PostgreSQL run. This is shared text/core behavior; signed voice and a buyer monolith still need their own conformance proof.

`npm test` passed typecheck and 472 memory cases with 23 PostgreSQL-only skips. `npm run probe:postgres` passed 793/793 cases with no failures, cancellations or skips (`Abby final cross-mode full PostgreSQL probe`, 4m58s, exit 0). The scenario-manifest contract and `git diff --check` also passed.

E2E-200 now adds two signed standalone calls for complete empty availability, with its approved alternative disabled and enabled. The synthetic Cliniko fixture returns a complete zero-entry page for each selected reader; the caller hears exact no-time wording, the read count follows the approval, and no write or patient canary reaches storage, backup or runner output. `bash scripts/with-postgres.sh node --test test/voice/standalone-voice-failures.test.ts` passed 27/27 cases (`Abby B4 signed empty availability PostgreSQL test`, 2m03s, exit 0). `npm run test:settings-isolation:postgres` passed 114 Node cases across fourteen files alone and in both four-worker orders, plus twelve browser cases across four files alone and in both three-worker orders (`Abby B4 mapped setting isolation in parallel`, 7m41s, exit 0). The fixture is a signed synthetic call through the disposable standalone runner, not a carrier call or a real clinic's approval.

## Cross-mode knowledge and review addition — 2026-10-01

Manifest version 1.21 maps E2E-223 to the automation and knowledge-approval settings. Its new text/core scenario passed against separate disposable PostgreSQL databases in strict standalone and authorized embedded reference modes. It checks truthful fallback before approval, clinic-admin-only knowledge drafting and approval, a sourced answer on a new embedded call, denied and redacted review, and standalone database and backup canaries.

The first mapped isolation run stopped in the existing signed E2E-199 week-option case while a live OpenAI evaluation was also running: the fixture saw the greeting again instead of the provisional response. The exact 28-case signed file then passed on a focused disposable-PostgreSQL run. The clean-load retry `Abby E2E-223 mapped isolation clean-load retry` passed in 9m07s: **116 Node cases across 15 files** alone and in both four-worker orders, and **12 browser cases across four files** alone and in both three-worker orders. The first failure's cause is undetermined; the retry proves the current mapped cases pass under the declared file parallelism, not that E2E-199 is free of intermittent failures under other load.

## Signed response-audio assertion — 2026-10-01

The shared synthetic runner now gives greeting and subsequent utterances distinct fixed PCM tones. E2E-199 checks the outbound media payloads differ, alongside its response wording, scoped Cliniko reads and privacy canaries. This distinguishes repeated caller-facing greeting audio from a duplicate or delayed cross-process speech-request observation if the intermittent failure recurs. It is a synthetic audio marker, not a speech-quality or carrier-listening result. The focused 28-case signed file and typecheck passed. `Abby response-audio mapped parallel isolation final` passed in 11m00s under concurrent machine load: **116 Node cases across 15 files** alone and in both four-worker orders, and **12 browser cases across four files** alone and in both three-worker orders. The earlier E2E-199 failure did not recur; its cause remains open.

## Write-stop resume across calls — 2026-10-01

**Implementation revision tested:** `dc795c47ed449a4d1e9fd5f044e23c59864f8168`. Manifest version 1.22 maps the additional E2E-074 synthetic media journey to the write-stop setting. The embedded reference call hears booking details, then a clinic write stop blocks its affirmation and queues an unresolved notice. A stale-version resume fails; the valid resume cannot replay the blocked booking, while a new call can make one confirmed booking. The previous E2E-074 memory and PostgreSQL voice tests still stop an active action after affirmation but before host dispatch. The browser E2E-074 still checks clinic-admin stop/resume authorization and audit.

`node --test test/voice/embedded-booking-setting-call.test.ts test/contract/scenario-manifest.test.ts` passed 3/3 after the manifest version update; typecheck passed. The tracked `npm run test:settings-isolation:postgres` run passed **117 Node cases across 15 files** alone and in both four-worker file orders, and **12 browser cases across four files** alone and in both three-worker orders (`Abby E2E-074 stop-resume mapped setting isolation`, exit 0, 10m59s). The new call uses synthetic media and an authorized embedded reference host. It does not enable a standalone Cliniko booking, prove signed carrier playback, or supply a clinic identity source.

## Call-bound Cliniko booking host — 2026-10-01

Manifest version 1.25 maps E2E-226 to the booking setting and write stop. Nine synthetic embedded voice cases exercise host-issued patient proof, an exact offer and separately attested exclusive-commit permit, current policy, played confirmation, one Cliniko POST, and exact observation after a lost response. Denied or changed evidence, write stop and hangup prevent the POST; an empty observation after 409 or 503 does not permit a retry. This host is not constructed by the live standalone runner because the Cliniko demo profile still has no proven exclusive booking mechanism.

`npm test` passed typecheck and 490 tests, with 26 PostgreSQL-only skips. `npm run test:settings-isolation` passed 15 cases across six files in both four-worker orders. The tracked `npm run test:settings-isolation:postgres` run (`Abby C3 booking mapped PostgreSQL and browser isolation final`, exit 0, 10m06s) passed **126 Node cases across 16 files** alone and in both four-worker file orders, and **12 browser cases across four files** alone and in both three-worker file orders. The first mapped PostgreSQL attempt failed in the existing E2E-176 database-loss case when its health fetch rejected; the signed runner file then passed 28/28 with a bounded health request and runner-state diagnostics, and E2E-176 passed in all three modes of the final sweep. Its intermittent cause is still unknown. These tests prove synthetic composition behavior and file-order isolation, not a production Cliniko reservation, carrier call, or process-loss recovery of a booking.

## Signed cross-mode booking conformance — 2026-10-01

Manifest version 1.27 adds signed synthetic HTTP/WebSocket evidence to E2E-222. The same booking request and affirmation pass through strict transient standalone and authorized durable embedded voice compositions against separate disposable PostgreSQL databases. Standalone speaks an unavailable fallback and closes on the unsupported affirmation without a booking or durable private data; the embedded host holds the booking until detail playback and affirmation, commits once, and recovers the committed action from a new database connection. Unsigned ingress is refused before either call is constructed. This supplements the existing text/core write-stop and agent-command checks; it does not prove signed write-stop, a real buyer host, a carrier call, or clinic approval.

`npm run typecheck` and `node --test test/contract/scenario-manifest.test.ts` passed. The focused disposable-PostgreSQL run of the new signed test and existing text conformance passed 2/2 with two Node workers. The tracked `npm run test:settings-isolation:postgres` run (`Abby D2 mapped setting parallel PostgreSQL isolation`, exit 0) passed **127 Node cases across 17 files** alone and in both four-worker file orders, and **12 browser cases across four files** alone and in both three-worker file orders.

## Signed cross-mode knowledge conformance — 2026-10-01

Manifest version 1.28 adds signed synthetic HTTP/WebSocket evidence to E2E-223. Both modes speak the fallback before approval; strict standalone still speaks it on a later call, while the authorized embedded host speaks a sourced answer after approval. Unsigned ingress is denied before constructing a call. Separate disposable PostgreSQL databases show no standalone call row or call, caller, question or answer canary in rows and backup, while the embedded redacted knowledge citation survives a new database connection. Agent authorization and review-command behavior remain covered by the existing text/core test, and E2E-004 separately tests revocation during an embedded signed call. No carrier call, buyer host or clinic approval is established.

`npm run typecheck`, the scenario-manifest contract test, the focused disposable-PostgreSQL signed case and `git diff --check` passed. The tracked `npm run test:settings-isolation:postgres` run (`Abby D2 signed knowledge mapped PostgreSQL isolation`, exit 0, 9m49s) passed **128 Node cases across 18 files** alone and in both four-worker file orders, and **12 browser cases across four files** alone and in both three-worker file orders.
