# Local admin and E2E closure audit

**Scope:** the number-independent admin, agent conformance, operations and test isolation work in A2 and D1–D4 of [the work plan](../NO_TWILIO_NUMBER_WORK_PLAN.md). This audit separates local engineering evidence from deployment and clinic activation. It does not close every PRD requirement, the entire work plan, or patient-call readiness.

**Baseline:** `918df0caa6165b9121b8524d5502d0c848527b9e`, after normal merges of sign-in PR #357, agent proposals PR #358 and operational identity PR #359. No email delivery service is selected; all email delivery evidence is synthetic.

## Requirement audit

| Package | Local contract and evidence | Remaining boundary |
| --- | --- | --- |
| A2: feature/setting E2E | The checked registry maps all 17 setting groups to complete executable feature files. The contract detects missing catalogue/mapping/overview IDs and planned evidence presented as passed. Actual Node dispatch and browser fixture release coordinators record both parallel orders. The proposal release passed 517 mapped Node checks across 60 files, alone and in both four-worker orders; the later operations release passed 62 mapped browser journeys across 13 files, alone and in both three-worker orders. | Registration proves evidence exists, not that every assertion is sufficient. The feature contracts below document default/on/off/invalid/failure, active versus new calls and privacy. Full-call entries remain planned. Historical intermittent failures remain recorded rather than reclassified by later green runs. |
| D1: reference admin | Direct lit-html uses the typed gateway for approval, policy, audit and uncertain-save recovery. Caller policy is captured at admission; raw settings cannot grant an unsupported host capability. The 17-group table below names executable scenarios rather than relying on suite totals. | Reference and embedded settings do not imply every control is supported by the restricted standalone dashboard. Carrier fallback, participating-clinic wording, staffed routes and patient workflows remain gated. |
| D1: standalone identity | D-14 selects Abby-owned magic links. E2E-260 proves explicit redemption, expiry/replay, cookie/CSRF/Origin, trusted current membership, restart, logout, scoped greeting persistence and secret exclusion through real local HTTPS and PostgreSQL. E2E-262 adds the actual operational/speech screens and permitted setup loading. | Real mail transport/sender, approved accounts and recovery operator, HTTPS/proxy deployment and mailbox delivery are not complete. No provider account or credential was created. |
| D2: agent and embedding | E2E-222/223 exercise the same booking, knowledge and review commands across strict transient standalone and authorized durable embedded hosts, including signed synthetic voice. E2E-261 extends proposal authority, separate caller confirmation, write stop, replay/reconnection and privacy to cancellation, rescheduling and intake. | No buyer monolith is integrated. Cliniko patient actions remain unavailable. Synthetic presentation/playback is not real carrier proof. |
| D2: read-command evidence | The audit found two catalogue mappings pointing only at planned scenarios: `appointments.read.v1` and `staff.list.v1`. E2E-263 supplies complete command evidence, including scope/proof/capability failures, redacted results and truthful provider/storage failure. The registry now requires executable evidence for all 59 catalogue entries. | Existing patient-verification and staff-delivery scenarios E2E-003/009/068/117 stay planned; a reader test cannot prove those complete scenarios. |
| D3: privacy-safe operations | E2E-217–221/228/235/237 cover fixed-code totals, seven UTC days, retention, selected thresholds, redacted webhook acceptance, bounded queue/recall aggregates, exact actor scope and failure. E2E-262 proves the allowed screens through actual magic-link membership, including downgrade/revocation and unavailable-data UI. | Aggregates are best effort and cannot reconstruct calls or establish human delivery. Retention/alert timer templates are not installed. A real receiver must deduplicate and acknowledge alerts. Patient follow-up requires C1 and clinic approval. |
| D4: synthetic failures and load | [The failure/load map](FAILURE_LOAD_EVIDENCE.md) records eight simultaneous signed read-only calls across two clinics, a shared budget and ninth-call refusal, duplicate ingress, provider faults, database loss and abrupt restart, plus separate reference uncertain-effect cases. These cases participate in the later backend release. | No carrier capacity/latency, exact post-crash standalone patient recovery or safe Cliniko mutation contract is established. Old transient calls are lost rather than replayed. |

## Setting coverage checked

These are registry setting groups, not 17 independently deployable Cliniko controls. The corresponding versioned feature contracts and tests own their assertions; the registry only enforces traceability.

| Setting group | Principal executable scenario(s) |
| --- | --- |
| `availability.sevenDay.enabled` | E2E-199, E2E-247 |
| `appointments.booking.enabled` | E2E-010, E2E-222, E2E-226, E2E-253 |
| `appointments.cancellation.enabled` | E2E-252, E2E-261 |
| `appointments.rescheduling.enabled` | E2E-254, E2E-261 |
| `patients.firstTimeIntake.enabled` | E2E-255, E2E-261 |
| `automation.enabled` | E2E-018, E2E-248, E2E-253 |
| `calls.writes.stop` | E2E-074, E2E-222, E2E-226, E2E-261 |
| `clinic.availability.approval` | E2E-194/195, E2E-200/201, E2E-209/210, E2E-212/214/215 |
| `knowledge.approval` | E2E-004, E2E-223 |
| `routing.staffedDestination` | E2E-256 |
| `notifications.owner` | E2E-257 |
| `routing.afterHoursMode` | E2E-229 |
| `routing.urgentResponse` | E2E-232 |
| `routing.staffSchedule` | E2E-244 |
| `routing.greeting` | E2E-245/246/247, E2E-260 |
| `voice.locale` | E2E-258; E2E-262 adds actual staff denial |
| `voice.voiceId` | E2E-259 |

The [isolation evidence register](../phase-0/SETTING_E2E_ISOLATION_EVIDENCE.md), [intake](CLINIC_FIRST_TIME_INTAKE.md), [staffed destination](STAFFED_TRANSFER_DESTINATION.md), [notification ownership](CLINIC_NOTIFICATION_OWNERSHIP.md), [voice profile](CLINIC_VOICE_PROFILE.md), [sign-in](STANDALONE_MAGIC_LINK_IDENTITY.md), [proposals](AGENT_APPOINTMENT_PROPOSALS.md) and [operational identity](MAGIC_LINK_CLINIC_OPERATIONS.md) preserve exact sources, commands, failures, recovery and limits. Counts from different revisions are not summed into one purported run.

## Final read-evidence correction

Frozen source: `7989fffcc74380575b4ac1df147b1ae79e3d56c5`. Production code, scripts, dependencies and generated database types are unchanged from the merged baseline. The change adds semantic failure tests, corrects registry links and strengthens the existing registry contract; it creates no new patient capability.

The stronger registry assertion first failed for the appointment reader as expected. The first focused invocation passed typecheck and seven cases but failed one new test's expected foreign-scope error: the ledger deliberately returns `callUnknown` for a foreign scope. Checking its implementation established the contract; the assertion was corrected to that exact error while retaining zero protected reads. The registered memory correction then passed ten complete-file checks with zero failures/skips.

Final PostgreSQL and ordering gate: **passed, terminal exit 0, 2m20s**. Tracked job: `Abby 7989fff protected read registration PostgreSQL and two order closure gate`; log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791014904368.log`.

- `npm run build:availability-console` and `npm run typecheck` passed.
- All five complete files passed individually: **20 checks total**, zero failures/skips.
- The same five files passed in recorded forward and reverse four-worker dispatch orders: **20 checks in each run**, zero failures/skips. Each invocation used fresh migrated disposable PostgreSQL and `ABBY_LEDGER=postgres`, so the appointment cases exercised both memory and PostgreSQL.
- Exact source before/after, tracked-input diff and `git diff --check` passed. Production code, scripts, dependencies and generated types compare unchanged from PR #359.

Files: `test/voice/appointment-read.test.ts`, `test/text/staff-queue.test.ts`, `test/storage/standalone-privacy-journey.test.ts`, `test/contract/scenario-manifest.test.ts`, `test/contract/no-number-gap-trace.test.ts`. Each isolated invocation used `bash scripts/with-postgres.sh env ABBY_LEDGER=postgres bash -c 'npm run db:migrate && node scripts/ordered-node-e2e.mjs <options>'`, where `<options>` contains the explicit file list and concurrency of one or four. The gate is preserved as `/tmp/abby-admin-e2e-closure-gate.sh`; logs record every requested and observed dispatch. Neither deadlines nor workers were reduced to resolve a failure.

Actual browser and other production inputs are unchanged from PR #359; another complete browser suite would not resolve a remaining risk in this registry/test-only correction. This is affected-file release evidence, not a claim that the entire backend or browser suite ran on this correction.

A direct maintainability pass found no remaining substantive issue in this change: the tests reuse the actual gateway, reception and existing fixture; the only additional provider branch injects a 503 at the protected read; the governance change extends one existing rule to the complete catalogue. No runtime dispatcher, authorization logic or storage abstraction is duplicated.

## What remains before operating a clinic

- Select and integrate real magic-link delivery; provision approved clinic accounts and recovery ownership; deploy and verify HTTPS and proxy handling.
- Operate the retention and alert schedules with a chosen deduplicating receiver and verify human delivery separately from HTTP acceptance.
- Obtain the owned Twilio number and prove incoming routing, independent fallback, media/latency/interruptions, transfers and the representative listening corpus.
- Keep natural-language promotion off while the source-matched speech gate fails. A synthetic status screen cannot pass that gate.
- Keep patient disclosure and actions off until each capability has trusted clinic verification/workflow and operation-specific provider evidence. The Cliniko collision and standalone recovery limits remain unresolved; clinic approval alone cannot repair them.
- Validate Splose and a real buyer host when those accounts/integrations are available.

The useful local admin/E2E engineering checklist has terminal passing evidence. Publication and hosted-check evidence are recorded in the pull request containing this audit; the local terminal proof above is independent of hosted execution. Deployment and activation remain separately incomplete; this is not a production launch report. Future features still require their own executable scenarios and parallel isolation proof.
