# Aeva → Abby gap analysis: receptionist core and Cliniko

**Snapshot:** 2026-09-30. **Purpose:** identify what Abby must prove or build to cover the useful Aeva receptionist and Cliniko behavior, while preserving Abby's standalone privacy rule and its ability to run inside a buyer's monolith.

## Evidence boundary

- **Aeva:** committed `origin/dev` at `7a0af655503ed70ad0a05ed6373363d682f943ad` in `aeva-ai/aeva-website`. The local feature checkout has uncommitted changes and was excluded. Aeva's production deploy is a manually selected commit; this review did not establish the deployed SHA, observe calls, or run its tests. “Aeva has” below means a source path exists at this snapshot, not that every clinic has the feature enabled or that it worked in production. Its [Cliniko flow map][a-flow] was verified at an older commit, so its risk register is a lead for revalidation rather than a fresh defect verdict.
- **Abby:** `main` at `52555b745ebe5c2bfdc579e67e738079a8ad9a1b`. “Reference core” means a typed implementation exercised with a synthetic host. “Standalone” means the composition intended for a Cliniko clinic. A demo Cliniko API probe establishes only the operation and fixture tested. A synthetic Twilio stream or tunnel does not establish carrier delivery. The [support matrix](phase-0/SUPPORT_MATRIX.md) and [decisions](phase-0/DECISIONS.md) govern the standalone capability modes; the [PRD](PRD.md) describes the target, not the current product.
- This is **functional and integration parity**, not an audit of Aeva's whole SaaS, a complete Cliniko API inventory, or a judgment that Aeva's current implementation should be copied. Abby already has a [published API inventory](phase-0/CLINIKO_API_SURFACE.md) for the latter.

## Summary

**Aeva is much broader as a receptionist:** its Vapi squad, live tools, post-call workers, Cliniko setup, patient/appointment flows, booking, cancellation, rescheduling, group classes, notifications, and operational reporting are represented in code. **Abby is further along on explicit boundaries:** its typed SAM state/action loop, host contracts, patient data minimization, playback/lease rules, and synthetic end-to-end tests are designed for portability. Abby's standalone Cliniko product is currently a guarded, read-only availability test path, not an Aeva replacement.

The critical path is **real-call evidence → approved identity and handoff policy → safe Cliniko write semantics → broader dialogue and clinic operations**. Aeva's features give a scenario inventory; its post-call timing, data persistence, and retry behavior should not automatically become Abby's contract.

### Status and priority key

| Label | Meaning |
| --- | --- |
| **Aeva source** | Active-looking code path at the pinned commit; deployment and success not independently verified. |
| **Abby reference** | Implemented against synthetic host/media with tests; not wired to standalone Cliniko. |
| **Abby probe** | A narrow demo-account or live provider observation; not approved automation. |
| **Abby standalone** | Wired into the current local Cliniko composition, subject to its test-only admission gate. |
| **P0 / P1 / P2** | P0 blocks safe live-call readiness or a basic individual-booking product; P1 blocks substantial Aeva workflow parity; P2 is expansion or convenience. A row can depend on a clinic decision even when the code is ready. |

## Core receptionist gap

| Capability | Aeva source state | Abby state and exact gap | Priority |
| --- | --- | --- | --- |
| Inbound call admission and routing | Vapi asks Aeva for a per-call squad; transient routing branches on business, practitioner, caller/household and outbound context. `A1` | Signed Twilio webhook/stream, clinic-number binding, shared-number intake and fallback rules exist; the standalone server accepts only an allowlisted test route. No carrier call or clinic activation proof. `B1`, `B2` | P0 |
| Live turn control and spoken dialogue | Vapi owns media orchestration, handoffs and speech provider behavior; Aeva supplies prompts and server tools. `A1`, `A2` | Abby owns stream normalization, turn assembly, interruption, playback marks, synthesis fallback and session leases. The standalone runner's natural-language availability is held behind a speech quality gate; keypad availability is the permitted path. No representative carrier audio or end-to-end conversational quality evidence. `B1`, `B3` | P0 |
| Intent, corrections and multi-step calls | Aeva has during-call tool state and post-call categorization/multi-action handling. `A2`, `A3` | Typed proposals, transitions, corrections and multiple actions exist in reference tests; no equivalent standalone Cliniko booking/cancel/reschedule conversation is enabled. Add realistic whole-call cases, including withdrawal, interruption and wrong-patient recovery. `B4` | P1 |
| Typed outcomes and effect authority | Aeva's PMS adapter returns operation-specific success/error results, while controllers and post-call handlers own further action and wording decisions. `A2`, `A4` | Abby's SAM transition accepts typed actions and effect results so model proposals cannot themselves commit a PMS change. This is implemented in the reference core; Cliniko write effects and real speech-led action gating remain absent from standalone. `B4`, `B5` | P1 |
| Claim versus action timing | `confirm_booking` validates/logs during a call; post-call handlers perform the Cliniko write and may later recover or report an incomplete booking. That path cannot give the caller a same-call receipt for a completed PMS write. `A2`, `A3`, `A4` | Abby's reference contract ties a completed confirmation presentation to a typed effect and a verified receipt/unknown result. The standalone Cliniko host has no write effect. The caller wording and operational handling of a post-call or unknown outcome need product approval before parity can be claimed. `B4`, `B5` | P0 |
| Caller identity and disclosure | Aeva uses its local phone mirror, live Cliniko reads and separate name/DOB lookup; failed pre-call lookup can fall back to unidentified routing. `A1`, `A5` | Abby has a minimal phone→ID index, fresh candidate re-read and exact email/DOB candidate reader. A phone match remains unverified, and no clinic-approved spoken identity proof/disclosure flow is wired. `B6`, `B7` | P0 |
| Staff transfer and unresolved work | Aeva has transfer configuration, message handling and post-call clinic/operator notifications. `A3`, `A6` | Abby has reference transfer and staff lifecycle contracts and a synthetic transfer test. In standalone Cliniko, patient-specific handoff is **disabled** until a clinic approves a Cliniko-owned queue and its delivery/reconciliation path. No real transfer/fallback ringing proof. `B2`, `B5` | P0 |
| Opening hours and urgent requests | Aeva's transient templates include operating-hours and transfer rules; their exact clinic behavior requires deployed-call review. `A1`, `A7` | Abby has location-scoped staffed-window logic and a requirement for approved urgent wording; no real clinic hours/holiday configuration or end-to-end urgent-call handling is live. Unproven staff delivery must never be described as completed escalation. `B5`, `B8` | P0 |
| Process loss, duplicate delivery and recovery | Aeva has persisted pre/post-call dispatch, booking idempotency and job retries; operation-specific gaps are recorded in its flow map. `A3`, `A4` | Abby's embedded host can persist replay/effect evidence. Standalone deliberately keeps call state in memory and uses a cross-process active-call lock: it cannot promise crash-surviving replay refusal or call reconstruction. It requires a proven independent provider fallback. `B2`, `B5` | P0 |
| Knowledge and clinic policy | Aeva has FAQ, profile, scripting and call-flow preview surfaces feeding transient prompts. `A1`, `A7` | Abby has an approved/versioned knowledge catalogue and typed policy commands, with synthetic UI tests. Standalone voice has a route-approved greeting but no complete Cliniko clinic setup or full live knowledge/dialogue rollout. `B8` | P1 |
| Clinic administration | Aeva has Cliniko onboarding, business/practitioner/type selection and operational settings UI. `A7`, `A8` | Abby has a lit-html reference dashboard and availability console, plus schema-checked commands. They are not a secured, production Cliniko admin workflow with onboarding, permissions and all settings. `B8` | P1 |
| Agent-native operations | Aeva's main call path is voice-agent/tools oriented; its PMS logic is dispersed through controllers, handlers and adapters. `A2`, `A3` | Abby's role-filtered capability catalogue and command gateway share typed actions between UI and host agents in reference composition. No deployed agent protocol, production auth or complete Cliniko agent action set. `B8` | P1 |
| Call review, outcomes and telemetry | Aeva stores call logs, handles Vapi transcript and recording data, and sends clinic notifications; monitoring jobs exist. `A3`, `A6`, `A9` | Abby has synthetic call review/outcome and non-patient operational alert contracts. Standalone cannot persist patient-linked calls, transcript, appointment outcomes or tasks. A Cliniko-owned staff view and useful aggregate reliability metrics remain to be proven. `B5`, `B9` | P1 |
| Patient-data boundary | Aeva's phone mirror is narrow, but cross-provider lookup/validation logs store patient and appointment fields; other call data stores are outside that inventory. `A9` | Abby's first standalone release permits **patient-specific** durable data only in the phone↔Cliniko-ID index; clinic settings and non-patient operational data have separate rules. This is a deliberate difference, not a missing feature to fill with local call tables. Richer patient reporting or follow-up must live in Cliniko or an authorized embedded host. `B5` | P0 constraint |
| Tenant authorization and secret handling | Aeva has JWT/webhook and tenant-scoped routes, with route-specific Cliniko compatibility paths; the flow map records boundaries that need separate review. `A8` | Abby has scoped typed commands, signed Twilio ingress and synthetic database tenant constraints. A real clinic identity/role provider, secret rotation and an authenticated admin deployment are not wired. `B1`, `B8` | P0 for live setup |
| Portability to an acquirer | Aeva has a PMS adapter/registry, but Cliniko-specific setup, direct controller paths, raw-SQL database records and Vapi lifecycle remain coupled to its SaaS. `A2`, `A8` | Abby's host, ledger, policy, model and voice ports are intended for in-process composition; standalone uses generated Kanel/Kysely database types. Only synthetic embedded composition has been exercised, and a buyer's schema and runtime remain unknown. Transferable behavior and conformance tests matter more than assuming unchanged code reuse. `B4`, `B8`, `B12` | P1 |
| Test and operating evidence | Aeva has extensive unit/integration/cross-layer tests and production-oriented run paths; this review ran none and did not inspect a deployed call. `A8`, `A11` | Abby has parallel synthetic contract, PostgreSQL, browser and signed-runner tests plus live demo/provider probes. Its declared speech gate failed, and no real Twilio call has run. Every new feature or setting needs a whole-call enabled/disabled/failure E2E. `B2`, `B3`, `B11` | P0 gate |

## Cliniko integration gap

| Capability | Aeva source state | Abby state and exact gap | Priority |
| --- | --- | --- | --- |
| Account connection and catalogue | API key/config, business, practitioner, appointment type, mapping, sync and formatted prompt data paths exist; legacy and standardized tables coexist. `A7`, `A8` | Demo metadata reads and a scoped availability reader exist. No general onboarding and metadata→approved policy/route adapter for a real clinic. `B7` | P1 |
| Phone-based patient resolution | Local mirror plus full/incremental/manual sync and live detail fetch. `A5` | Guarded, resumable clinic-scoped phone index and fresh Cliniko ID re-read; one demo-account refresh was observed. Need complete refresh, stale/shared-number, credential-change and real caller verification proof. `B6`, `B7` | P0 |
| Existing appointment discovery | Live individual and group lookup feeds manage flows and post-call target selection. `A2`, `A5`, `A10` | Read-only individual appointment adapter and one synthetic-record live observation behind a host proof; no approved caller disclosure or standalone appointment-management route. Group lookup absent from Abby's current Cliniko reader. `B7` | P0 for individual; P2 for group |
| Availability and eligibility | Online-booking availability, offline roster fallback, practitioner/type alternatives, classes, bounded search and timezone formatting exist across Cliniko and shared paths. `A2`, `A10` | Scoped online-booking availability and provisional time presentation work in text/keypad voice; demo and synthetic evidence exists. No reservable offer, offline-calculated slot, full alternative ranking or representative live dialogue. `B7`, `B10` | P0 for truthful basic availability; P1/P2 for breadth |
| Slot confirmation and collision | During-call slot validation exists; post-call write rechecks conflicts. Aeva's flow map records fail-open conflict and group-capacity race concerns at its older baseline. `A2`, `A4` | Demo Cliniko accepted **two concurrent same-slot creates**. Abby therefore blocks automated booking until exclusivity or a clinic-approved conflict route, current permission, revalidation and uncertain-response reconciliation are proven. `B7` | P0 |
| Individual booking | Post-call booking service creates/finds patient, writes appointment, records idempotency, retries and notifies. `A3`, `A4` | Reference host keyed booking only; no standalone Cliniko appointment write adapter. `requestOnly` is also unavailable without a proven Cliniko-owned staff request route. `B5`, `B7` | P0 for useful booking product |
| Cancellation | Post-call handler and Cliniko adapter cancel individual appointments; retry path exists. `A3`, `A4` | Demo synthetic cancel succeeded, but no standalone adapter or safe exact-target/unknown-result automation. `B7` | P1 |
| Rescheduling | Post-call handler and adapter move individual appointments and handle group changes/partial outcomes. `A3`, `A4` | Demo synthetic PATCH succeeded, but no standalone adapter or proven atomic/compensated workflow. `B7` | P1 |
| New-patient intake and booking for another person | Aeva can create a patient from post-call extracted data and handles on-behalf cases. `A3`, `A4` | Demo synthetic patient create succeeded. Consent, duplicate detection, stable identity, recovery and clinic approval remain open; no standalone intake write. `B7` | P1 |
| Classes/group appointments and multi-action | Aeva's adapter supports class membership, group cancellation/reschedule and multi-leg calls. `A3`, `A4`, `A10` | Abby's Cliniko integration does not implement group attendance or multi-action writes. Treat as a separately gated expansion, not a prerequisite for a narrow individual-appointment release. `B7` | P2 |
| Pricing, deposits and patient notifications | Aeva fetches pricing and has deposit/payment, SMS/email and clinic notification paths. `A4`, `A10` | Abby can present host-approved knowledge in reference flows, but has no Cliniko pricing/deposit/notification integration. Determine clinic policy before promising price or payment outcomes. `B8` | P2, unless pilot clinic needs it |
| Cliniko-owned follow-up | Aeva uses messages, alerts and transcript-in-Cliniko options alongside its own data stores. `A3`, `A9` | Abby tested recall create/read/mark/archive in the demo, but that proves neither staff ownership nor delivery, due/overdue review, nor safe lost-response retry. Patient-specific handoff stays off. `B5`, `B7` | P0 |
| API budgets, stale data and timezones | Aeva has caches, sync jobs, rate-limiting and timezone helpers, with path-specific behavior. `A5`, `A8`, `A10` | Abby has a shared PostgreSQL Cliniko read budget, bounded reads and clinic-zone presentation. Need realistic multi-clinic load, outage, catalogue drift and DST end-to-end proof before scale claims. `B7`, `B10` | P1 |

### What should carry over, and what should not be mistaken for parity

1. **Carry over scenarios and clinic configuration vocabulary:** Aeva's routing variants, service/practitioner mapping, household calls, alternatives, appointment management, message taking, classes and post-call failure cases are a high-value test corpus. Capture anonymized inputs, expected caller wording, authorized Cliniko effect and staff outcome for each. `A1`, `A2`, `A4`
2. **Carry over hard-won Cliniko semantics selectively:** timezones, online-booking eligibility, exact patient and appointment targeting, practitioner changes, group capacity, rate limits and partial failures need operation-specific proof. The adapter surface is an inventory, not evidence that one generic adapter makes all behavior safe. `A4`, `A8`, `A10`
3. **Keep Abby's separate contracts:** a typed action result, confirmation playback evidence, privacy-limited persistence and explicit `unavailable` mode are intentional constraints. Aeva's post-call promise timing, transcript-derived identities, local patient-linked logs and generic retries cannot be transplanted without re-approving their safety and data consequences. `A3`, `A9`, `B5`
4. **Keep the voice provider replaceable:** Aeva's Vapi squads show what a mature voice layer must cover; Abby's Twilio/OpenAI runner covers part of it. A Vapi-backed voice adapter could be a short-term comparison or bridge, but Cliniko authorization, action policy and receipts must stay in Abby's host/core. Decide with identical real-call and failure tests, not feature-count inference. `A1`, `B1`, `B3`

## Recommended closure order and proof

| Order | Work package | Evidence needed to close it |
| --- | --- | --- |
| 1 | **Live voice safety gate**: dedicated Twilio number, independent fallback, real carrier media, interruption and process-loss behavior; improve noisy/safety speech and synthesis uncertainty. | Patient-free end-to-end carrier tests and human listening meet a declared threshold. The last declared synthetic gate missed critical terms in 12/18 noisy and 11/24 safety runs, with one uncertain speech job out of 40; it did not authorize natural-language availability. `B2`, `B3` |
| 2 | **Cliniko identity and scope**: onboarding, selected location/practitioner/type policy, phone refresh and explicit caller verification. | One clinic signs off on disclosure and verification; E2E cases show shared/stale/spoofed/anonymous numbers never disclose or mutate the wrong record. `B6`, `B7` |
| 3 | **Cliniko-owned staff destination**: approve a real queue/owner, due handling, acknowledgment and failure escalation, with exact reconciliation. | A patient-specific request survives a lost response and is demonstrably visible and owned in Cliniko. Until then, transfer failure/request-only stays unavailable. `B5`, `B7` |
| 4 | **First safe individual write**: host-issued offer, confirmation after completed speech, current eligibility, Cliniko commit, conflict and unknown-outcome handling. | Same-slot concurrency, timeout-after-commit, repeat webhook, caller hangup and write-stop E2E tests pass. If Cliniko cannot provide a safe automated booking contract, retain honest request-only through the proven staff route. `B4`, `B7` |
| 5 | **Cancel and reschedule**: exact appointment selection, fees/policies, atomic move or explicit partial recovery. | Separate positive, ambiguity, repeated delivery and uncertain-result E2Es for each capability; no “done” claim before verified Cliniko outcome. `B4`, `B7` |
| 6 | **Clinic product parity**: knowledge/settings UI, call review through permitted host data, operational alerts, broader intents, intake, groups, deposits and outbound only where demanded. | Each setting or feature has a caller-level E2E covering enabled, disabled and failure behavior; independent test files run in parallel with isolated fixtures. The first clinic's approved scope sets the order within this package. `B8`, `B9` |

**Release rule:** do not convert a reference-host test, demo API probe, synthetic stream, or Aeva source path into a claim of live Cliniko automation. Record the exact clinic, route, provider, version and test artifact that proves a capability. Repeat the whole-call E2E when its setting, prompt, model, transport or Cliniko adapter changes.

## Open evidence and decisions

- **Aeva deployment:** obtain its actual deployed commit and a de-identified behavior sample before calling any source-path feature production parity. Re-check the older [Aeva Cliniko flow map][a-flow] risk register against that commit.
- **Abby clinic approvals:** verification method, greeting, staff queue and failure route, patient intake consent, booking collision policy and caller wording after uncertain writes remain clinic/product decisions. `B5`
- **Cliniko write contract:** the demo's successful same-slot concurrent creates prevent assuming `/available_times` is a reservation. Determine whether a safe clinic workflow can support automated booking at all. `B7`
- **Standalone durability:** D-06/D-11/D-12 intentionally forbid patient-linked call/effect persistence in Abby. Confirm the provider fallback on actual process loss; never “solve” missing replay evidence by adding a local PHI call log. `B2`, `B5`
- **Patient-specific request route:** [The API surface inventory](phase-0/CLINIKO_API_SURFACE.md), [support matrix](phase-0/SUPPORT_MATRIX.md), and disabled standalone host agree that `requestOnly` is unavailable until a Cliniko-owned staff route is proven under D-07/D-11.

## Evidence index

**Aeva source** (pinned links; repository access may be required):

- **A1:** [transient squad orchestrator][a-transient], [routing decision service][a-routing].
- **A2:** [master tools controller][a-tools], [PMS adapter contract][a-pms-contract].
- **A3:** [pre/post-call route][a-dispatch], [post-call orchestrator][a-postcall], [booking/cancel/reschedule handlers][a-handlers].
- **A4:** [Cliniko adapter][a-adapter], [booking service][a-booking], [booking idempotency][a-idempotency], [Cliniko integration flow map][a-flow].
- **A5:** [patient phone lookup][a-phone], [patient sync sweep][a-sync].
- **A6:** [transfer service][a-transfer], [call monitoring job][a-monitor].
- **A7:** [Cliniko client controllers][a-client], [company profile editor][a-profile].
- **A8:** [Cliniko integration flow map][a-flow], [PMS sync adapter][a-pms-sync].
- **A9:** [patient-data storage inventory][a-privacy], [transcript storage service][a-transcripts].
- **A10:** [Cliniko adapter][a-adapter], [availability controller][a-availability], [group booking service][a-groups].
- **A11:** [server test tree][a-tests], [testing guide][a-testing-guide].

**Abby source and evidence:**

- **B1:** [standalone voice server](src/standalone/cliniko-voice-server.ts), [transient voice composition](src/standalone/transient-voice-composition.ts), [Twilio ingress](src/voice/twilio-ingress-server.ts).
- **B2:** [voice test runbook](phase-1/VOICE_TEST_RUNBOOK.md), [standalone privacy decisions](phase-0/DECISIONS.md), [public runner probe](scripts/probe-public-voice-runner.mjs).
- **B3:** [declared speech gate](eval/SPEECH_QUALITY_GATE.md), [live evaluation record](eval/LIVE_BASELINE_2026-09-29.md).
- **B4:** [typed runtime](src/core/runtime.ts), [embedded voice composition](src/reference/embedded-voice-composition.ts), [synthetic embedded voice E2E](test/composition/embedded-voice.test.ts).
- **B5:** [standalone disabled host](src/standalone/disabled-host.ts), [support matrix](phase-0/SUPPORT_MATRIX.md), [decisions](phase-0/DECISIONS.md).
- **B6:** [phone lookup](src/standalone/cliniko-phone-lookup.ts), [patient candidate reader](src/cliniko/patients.ts), [phone index/privacy gate](phase-0/PHONE_INDEX_AND_PRIVACY_GATE.md).
- **B7:** [Cliniko support matrix](phase-0/SUPPORT_MATRIX.md), [Cliniko evidence register](phase-0/CLINIKO_EVIDENCE.md), [API surface](phase-0/CLINIKO_API_SURFACE.md), [availability reader](src/cliniko/availability.ts), [appointment reader](src/cliniko/appointments.ts).
- **B8:** [command gateway](src/reference/command-gateway.ts), [knowledge catalogue](src/reference/knowledge-catalogue.ts), [lit-html dashboard scope](phase-1/LIT_HTML_DASHBOARD.md).
- **B9:** [call outcome report](src/reference/call-outcome-report.ts), [operator alert scope](phase-2/OPERATOR_ALERTS.md).
- **B10:** [availability console](src/standalone/availability-console/server.ts), [Cliniko read budget](src/storage/postgres-cliniko-request-budget.ts).
- **B11:** [test commands](package.json), [standalone server E2E](test/voice/standalone-cliniko-server.test.ts), [browser E2E](test/browser/dashboard.spec.ts).
- **B12:** [Kanel/Kysely setup](package.json), [generated database interface](src/storage/generated/Database.ts), [PostgreSQL connection](src/storage/connect.ts).

[a-transient]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/transient/transientOrchestrator.ts#L663
[a-routing]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/transient/routing/routingDecisionService.ts#L33
[a-tools]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/controllers/transient/masterToolsController.ts#L84
[a-pms-contract]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/pms/pmsAdapter.ts#L37
[a-dispatch]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/routes/vapi/prePostCallRoutes.ts#L10
[a-postcall]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/postcall/postCallOrchestrator.ts#L1155
[a-handlers]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/postcall/handlers/bookHandler.ts#L160
[a-adapter]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/pms/adapters/clinikoAdapter.ts#L415
[a-booking]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/postcall/bookAppointment/bookAppointmentService.ts#L215
[a-idempotency]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/postcall/bookAppointment/idempotencyService.ts#L5
[a-flow]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/docs/flows/cliniko-integration-end-to-end.md
[a-phone]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/cliniko/patients/patientPhoneLookupService.ts#L34
[a-sync]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/cliniko/patients/clinikoPatientSyncSweepService.ts#L202
[a-transfer]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/vapi/transferCallService.ts
[a-monitor]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/jobs/callMonitoringJob.ts
[a-client]: https://github.com/aeva-ai/aeva-website/tree/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/controllers/cliniko/client
[a-profile]: https://github.com/aeva-ai/aeva-website/tree/7a0af655503ed70ad0a05ed6373363d682f943ad/aeva-website/src/client-app/components/cliniko/CompanyProfileEditor/Sections
[a-pms-sync]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/pms/sync/adapters/clinikoSyncAdapter.ts
[a-privacy]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/docs/flows/pms-patient-data-storage.md
[a-transcripts]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/cliniko/transcriptStorageService.ts#L241
[a-availability]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/controllers/cliniko/availability/clinikoAvailabilityMasterController.ts
[a-groups]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/services/cliniko/groupBookings/groupBookingService.ts
[a-tests]: https://github.com/aeva-ai/aeva-website/tree/7a0af655503ed70ad0a05ed6373363d682f943ad/server/src/__tests__
[a-testing-guide]: https://github.com/aeva-ai/aeva-website/blob/7a0af655503ed70ad0a05ed6373363d682f943ad/docs/guides/testing.md
