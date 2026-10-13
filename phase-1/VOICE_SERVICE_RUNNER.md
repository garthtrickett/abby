# Local Cliniko voice service runner

## Clinical host composition

The exported `serveClinikoVoice` now accepts a deploying-host `clinicalHost`
factory. It receives the runner's database, clinic scope, Cliniko credential,
contact address and shared request budget. The returned `ClinikoVoiceClinicalHost`
owns explicit operation approval paths, current policies, patient permission,
verification delivery, patient lookup, model intent and any private intake
transcription. It constructs `ClinikoCallFlow` only after signed admission and
binds its ledger, session, cancellation signal and private playback to that call.

The standalone server checks the clinical host against fresh catalogue approval
at the webhook and again at stream construction: scope, policy version, primary
business/practitioner/type, credential fingerprint and time zone must match.
Its request budget must be the runner's shared budget. A changed approval denies
admission rather than silently selecting another clinical cohort. Each clinical
operation still checks its separate current approval and permission before any
disclosure or write; the catalogue approval itself remains read-only.

Clinical routes use the host's independently approved conversation greeting and
private keypad verification, not the availability keypad menu. The conversation
speech configuration has its own quality hash and must qualify independently.
The existing default command-line launch supplies no clinical host and retains
availability-only behaviour. Supplying a host does not change `/readyz`, signed
test-caller restrictions, clinic readiness or production admission. The real
sender, clinic staff acceptance, speech and carrier gates are still required.

The host's scoped `cataloguePolicy` is also used for fresh catalogue-policy
validation. Using the default availability store here would compare a clinical
host's current version with a different policy source. Independent operation
approval and permission still determine each patient action.

A deploying host can supply `voiceProfiles`; its policy must capture the same
qualified registry used to construct the physical adapters. The new synthetic
runner does this through `captureVoicePolicy` and an actual
`OpenAIVoiceProfileHost`, using patient-free HTTP and transcription ports.
`syntheticClock` is available only to the isolated fixture with the guarded
synthetic Cliniko key/account and database; no environment variable selects it.
The normal runner retains its real clock and 700 ms end-of-turn silence.

`test/voice/standalone-clinical-runner.test.ts` runs a separately compiled runner
process and database for booking, cancellation, rescheduling, appointment
information and private registration followed by an independently confirmed
booking. It also checks current-policy withdrawal, independent permission,
failed verification delivery, lost-write no-replay and clean shutdown. The
fixture IPC channel disconnects after shutdown and all owned databases are
removed. Caller inputs, provider mutations and speech are observed independently
in test memory; private fields/codes are excluded from ordinary transcription,
model input, runner output and durable database rows.

`test/voice/standalone-clinical-host.test.ts` extends E2E-299 to the actual
standalone server, shared PostgreSQL budget and active-call claims. Its provider,
permission, verification email and speech are patient-free fixtures. This is
synthetic serving-path evidence, not live clinical activation.

Run `npm run build:runtime` after installation or source changes. It emits separate JavaScript modules under `dist/runtime`; `npm run voice:local` and `npm run voice:test-policy` use those executables. Build once before starting or restarting the service. The modules retain the source entry-point checks and provider configuration. Synthetic subprocess tests build the same executables plus their guarded provider fixture with `npm run build:voice-tests`; direct focused Node test commands need that build first.

`npm run voice:local` starts the standalone composition on `127.0.0.1:ABBY_VOICE_PORT`. It validates the route and provider configuration, verifies the PostgreSQL privacy boundary and active-call lock database, then exposes signed Twilio webhook and media paths. `GET /healthz` returns 200 only while PostgreSQL answers a probe; it is an operational liveness check. `GET /readyz` returns 503 while patient calls are disabled. Deployment routing must use readiness, not liveness, to decide whether to send calls. `SIGINT` and `SIGTERM` close active sockets and the database connection.

An optional owner-only `ABBY_VOICE_OPERATIONS_TOKEN_HEX` enables `GET /internal/operations` for eight clinic-scoped aggregate counters. It must be exactly 64 hex characters. Four count denied admission checks, constructed call owners, voice failures and ended calls; four count local Cliniko budget denials, budget failures, provider 429 responses and provider 5xx and fetch failures during availability reads. A denied check is not necessarily a distinct call, and a provider 429 is not a patient outcome. The endpoint returns 404 when disabled; when enabled it requires an exact bearer token and returns only validated nonnegative counts. Run `npm run voice:ops` from an operator shell with the same token and `ABBY_VOICE_PORT` in its environment; it reads `127.0.0.1` and prints only the counts. Keep `/internal/operations` out of the public TLS proxy or tunnel route where possible. The default PostgreSQL store atomically shares committed counts across runners and survives restarts. Counters are best effort: a process can die before an increment commits, so they cannot reconstruct exact calls or identify a patient or delivered staff task. An injected host store may offer different durability. Database health and admission checks share one in-flight probe and return unhealthy within 1.5 seconds if it stalls; a later probe can recover after the in-flight check settles.

The runner needs a migrated `DATABASE_URL` and these environment values: `ABBY_VOICE_PORT`, `ABBY_TENANT_ID`, `ABBY_CLINIC_ID`, `ABBY_LOCATION_ID`, `ABBY_VOICE_ROUTE_VERSION`, `ABBY_CLINIKO_API_KEY`, `ABBY_CLINIKO_CONTACT_EMAIL`, `ABBY_TWILIO_TEST_NUMBER`, `ABBY_TWILIO_FALLBACK_NUMBER`, `ABBY_TWILIO_ACCOUNT_SID`, `ABBY_TWILIO_AUTH_TOKEN`, `ABBY_TWILIO_PUBLIC_WEBHOOK_URL`, `ABBY_TWILIO_PUBLIC_STREAM_URL`, `ABBY_TWILIO_BINDING_KEY_HEX`, `ABBY_GREETING_VERSION`, `ABBY_GREETING_APPROVAL_OWNER_REF`, `ABBY_GREETING_APPROVED_TEXT`, `ABBY_OPENAI_API_KEY`, and `ABBY_OPENAI_INTENT_MODEL`. The binding key is at least 32 random bytes encoded as even-length hex and must be identical on every serving instance. `ABBY_CLINIKO_BUDGET_USER_REF` is optional when a shared Cliniko user budget has been established. `ABBY_SEVEN_DAY_AVAILABILITY_ENABLED` defaults to `0`; `1` enables keypad 3 only when the versioned approved greeting also contains the exact sentence `Press 3 for possible times over the next week.`. A mismatch refuses startup. Each keypad read covers at most seven clinic-local calendar dates and never implies a held slot. The current versioned Cliniko approval supplies the primary practitioner, appointment type, ordered alternatives and business time zone for each admitted call. Changing that approval takes effect on the next call without editing runner environment values or restarting it. A legacy approval without a recorded business zone requires reapproval. If the provider changes the zone after approval, the caller gets direct-contact fallback instead of a time. The runner checks every choice against the same credential and shared request budget, then speaks its current Cliniko names if it offers an alternative time. One 15-second deadline covers the entire availability read, including ordered alternatives; a timed-out read uses the direct-contact fallback and cannot become a provisional-time claim. The public URLs must exactly match the eventual provider configuration. Never put secrets in the repository.

By default this runner supplies `unprovenReadiness` and returns 503 to a valid signed webhook before stream TwiML. `ABBY_VOICE_TEST_MODE=1` adds a restricted rehearsal path requiring an exact `ABBY_TWILIO_TEST_CALLER_NUMBER` and dialed test number on both the signed webhook and bound stream, plus healthy PostgreSQL and an explicitly enabled isolated automation setting. `/readyz` remains 503 for general routing. Caller ID is not proof of identity; use only a dedicated test number and synthetic/demo data. The greeting environment values represent a clinic approval only after a clinic owner actually approves the wording; setting them does not complete the clinic readiness gate. The Twilio trial has not proven its post-stream dial or number-level failure route on a real call. D-09 and D-12 therefore keep patient traffic disabled. `E2E-171` proves default refusal. `E2E-172` starts the runner in a separate process with isolated PostgreSQL and synthetic provider ports, and tests signed allowlisted admission, keypad output, interruption, forged stream rejection, and shutdown. `E2E-173` through `E2E-177` exercise OpenAI speech failure, Cliniko rate limit and timeout, isolated database loss, and abrupt runner death through signed synthetic calls; they scan database rows, a disposable backup, and runner output for patient canaries. `npm run voice:probe-runner-public` repeats the call path against that runner over a temporary public ngrok HTTPS/WSS tunnel using synthetic traffic. None of these is a carrier test. See the [real-call rehearsal runbook](VOICE_TEST_RUNBOOK.md).


## Combined clinical runner qualification, 2026-10-13

Dedicated branch `codex/abby-integrated-runner` reconciles the committed heads
of drafts453 (clinical runner),454 (TLS SMTP),455 (aggregate monitoring/operator
responsibility) and456 (current services/history/location/intake). All originated
from main `9a29e51e7f7e0a765db7674c6c75ff2087260473`. Source additions merged;
scenario evidence arrays were united, existing353 scenario meanings retained,
and the new E2E-354 compiled integration was registered at version1.161/354 IDs.
No policy, permission, admission, deadline, privacy or test gate was relaxed.

`ClinikoVoiceClinicalHost` freezes current service mappings and history settings
before constructing calls. The guarded compiled fixture uses the actual initial
service and private-registration components, with real loopback TLS SMTP
certificate/authentication/envelope/message validation. The existing-patient
journey inspects native type34; the first-time journey separately confirms
patient42 and type34/member24. Both scan private fields/codes in PostgreSQL and
runner output. This is synthetic provider/media evidence, not real recipient,
clinic, acoustic or carrier acceptance.

Exact qualification: `npm run typecheck`, `npm run build:voice-tests`,
`npm run build:cliniko-admin`, `npm run build:dashboard`,
`npm run build:sign-in`, isolated PostgreSQL
`node --test --test-concurrency=4` over integrated-clinical-runner,
standalone-clinical-host/runner, smtp-patient-code-delivery, queue-monitor,
operational-alert-inbox/receiver-postgres, operator-alert-workflow/http/process,
cliniko-queue-monitor-systemd and scenario-manifest/no-number-gap-trace files,
then `npx playwright test test/browser/operator-alert-responsibility.spec.ts`
and `git diff --check`. All62 Node checks and the browser journey passed, zero
skips. Work: `Abby combined runner SMTP and monitoring final qualification
October13`. Log:
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791890158011.log`.
The required sign-in asset build was separately tracked and completed before
browser startup in `4590eee3-1791890281469.log`. Earlier merged-source typecheck/
registry and17-check compiled clinical qualification also passed.

At that qualification point the production CLI provisioned one location.
Shared-number service discovery and exact different-business binding were
qualified in the transient composition. The follow-up below connects the CLI
to those location capabilities. Real clinic permission/recipient/operating
acceptance, failed acoustic quality, exact-head CI and carrier admission gates
remain separate. The full13 objective is active; gaps6–13 remain incomplete.

## Independently provisioned locations on a shared number

The trusted `clinicalLocations(context)` port supplies 1–32 named location hosts
for the configured clinic and number. It is mutually exclusive with
`clinicalHost(context)`. Each host keeps its own greeting, policy version,
approved service catalogue, patient permission, verification delivery and private
input adapter. Environment variables do not construct these authorities.

For shared numbers, every location needs independent current catalogue approval
and an approved public service catalogue whose location name agrees with the
directory. Public service questions expose only names, visit kinds and durations.
An explicitly chosen location selects the clinical owner and its private adapter;
patient reads and verification cannot start during location discovery. Candidate
locations must agree on the complete qualified voice profile.

The group rechecks the captured route approval on each policy use. Approval
withdrawal or replacement cannot reuse a pending location choice or verified
booking. Credentials share the existing PostgreSQL request budget across the
locations; each native provider request remains scoped to the selected host.
Admission denials before location selection belong to the number's first route;
clinical owner starts and subsequent failure/end counters use the bound location.

E2E-355 qualifies six compiled shared-number journeys: both location choices,
approval withdrawal before binding and before sending, independent permission
denial, and first-time registration followed by separate booking at South.
Distinct greetings, policy versions, TLS recipients, private adapter scope,
native business/type/member bodies and selected-location counters are inspected.
Source typecheck, compiled voice build and 37 related checks passed with zero
failures/skips in `Abby shared-number returning and first-time final clinical
gate October13`, log
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791892462458.log`.

Earlier attempts exposed fixture faults: the email setter did not affect the
native fixture response; a changed greeting lacked the required owner/effective
dates; a denial assertion ran before its asynchronous decision. Each was fixed
without changing authority, deadlines or concurrency. One earlier runner startup
exit was not reproduced in the focused or final broader run; its cause remains
unestablished and fixed-code diagnostics now preserve a future occurrence.
The shared helper's initial union type obscured the returning fixture's methods;
separate typed fixture constructors preserve both existing and intake evidence.

This implementation supplies no real clinic acceptance, mailbox receipt,
acoustic qualification or carrier admission evidence. Exact-head CI is a
separate publication gate.
