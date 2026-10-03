# Agent appointment and patient-intake proposals

## Status

Local implementation closes a D2 gateway gap: cancellation, rescheduling and intake were supported by the reception core and voice composition, but had no schema-defined agent proposal commands. No new patient action is enabled in standalone Cliniko. Manifest 1.71 registers E2E-261. The complete local release on source `558b66aa9e1c79dbe4f0fd3158a71b7d8071031c` passed, including actual PostgreSQL, full browser and mapped parallel isolation; see the final evidence below. Publication remains pending.

## Commands and authority

| Command | Exact input | Output |
| --- | --- | --- |
| `appointments.change.propose.v1` | `turn`, `selection`, `now`. A cancellation selection contains `kind: cancel`, `verificationRef`, `targetRef`. Rescheduling uses `kind: reschedule` and additionally `offerRef`. | `appointmentChangeProposal` with the existing redacted `CallCommandProgress` |
| `patients.intake.propose.v1` | `turn`, `draftRef`, `now` | `intakeProposal` with the same redacted progress |

Both require a final turn with `callId`, `sessionId`, `turnId`, `text`, `quality` and `at`. Schemas reject extra fields, missing sessions, invented operation kinds and operation-inappropriate fields. `now` must parse to a finite timestamp. The host authenticates the actor before constructing the gateway; actor, role and clinic/location scope are never taken from command JSON.

Both commands declare `proposalOnly`, `permittedActor` and required caller confirmation. Discovery uses the existing role-filtered catalogue. `settings.read.v1` exposes the effective captured host capability: discovering a proposal command does not grant execution permission.

The gateway invokes the existing `TextReception.proposeAppointmentChange` or `proposeIntake`. Those methods validate the current call/session, captured capability and trusted host evidence. Appointment evidence binds the verified patient, exact target, replacement offer where needed, and approved terms. Intake uses an opaque approved draft; consent and duplicate-check references come from the trusted host, never from the agent. Unavailable host evidence yields the existing truthful fallback without a patient action.

The command cannot mark details played, affirm for the caller, disable write-stop or supply a committed receipt. A patient write requires separately observed caller playback and affirmation, then passes the existing effect worker and write-stop checks. No command-specific clinical transition or provider writer is introduced.

## Storage and recovery

- **Strict standalone Cliniko:** raw setting edits leave cancellation, rescheduling and intake effectively unavailable. Calls remain in memory. The actual PostgreSQL policy composition stores no call, patient proof, draft, consent or caller-text canary; both database and disposable backup scans verify that limit. Disposing the call ledger loses the call.
- **Authorized embedded host:** an enabled host capability can produce an awaiting-confirmation action. The existing authorized ledger owns durable call/action state. Reopening a database connection preserves a committed action and repeating the proposal cannot repeat its write. A stopped ready action remains unsupported after writes resume.
- These local proofs do not establish provider idempotency, recovery from an uncertain Cliniko write across processes, real clinic verification/intake authority, or buyer-host deployment. Standalone patient actions remain disabled.

## Evidence and remaining work

`E2E-261` is registered in manifest 1.71 with text and synthetic voice evidence; full-call carrier evidence remains planned. Eleven memory cases cover each operation's default/off/on capture, separate confirmation and single write, strict unavailable mode, schema/scope/session denial and missing host evidence. Two disposable PostgreSQL cases run the same gateway commands through strict standalone and authorized embedded compositions, including every operation's write stop, reconnect/replay behavior and standalone database/backup canaries. Six actual voice-session cases use the same gateway proposals through synthetic playback and caller transcripts. Both new commands and the affected settings/write-stop mappings include this scenario; the manifest contract requires passing executable evidence for every proposal-only or policy-changing command.

Initial evidence is retained with corrections:

- The first memory run failed two appointment cases because its synthetic target omitted `endsAt` and `timeZone`. Correcting the target, without changing validation, passed eight cases with no skips. Logs: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007214309.log` and `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007296333.log`.
- The initial PostgreSQL/memory run passed ten complete-file cases without skips, including actual backup scans. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007518390.log`.
- Initial typecheck rejected undeclared precondition names and an unsupported memory booking-mode argument. The correction uses declared preconditions and leaves booking disabled in the memory fixture; the actual strict PostgreSQL host still supplies unavailable booking and patient modes. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007518181.log`.
- The expanded regression initially failed the exact discovery expectation and three pre-existing PostgreSQL cases because its base database had not been migrated. Adding the new command IDs to the discovery expectation preserves exactness; migrating the disposable base database restores its required setup. The corrected run passed **28 checks, zero failures/skips**, across the reference gateway, existing cross-mode booking, new proposal conformance and eleven new memory checks, with four file workers. Logs: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007649340.log` and `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007762561.log`.
- `Abby agent proposal precise catalogue type and current toggle typecheck correction` passed TypeScript and diff checks in 1m48s on these implementation and test inputs. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007762012.log`.
- `Abby agent proposal actual voice session spoken details caller affirmation and strict fallback proof` passed **17 checks with zero failures/skips**, including six complete `VoiceSession` journeys and the eleven memory gateway checks. Each embedded journey admits and attaches the actual voice session, plays the greeting, accepts an agent proposal, queues approved details, separately accepts their played result and a final caller transcript saying yes, then drains one host action and speaks its confirmed/saved outcome. Repeating the agent input cannot repeat the write. Strict journeys speak the unavailable fallback with no host read/write. All sessions end. This is the actual orchestrator with synthetic playback/transcripts; it does not include signed HTTP/WSS ingress, streamed PCM, carrier audio or a live model. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791008227860.log`.
- The first voice-fixture typecheck rejected two potentially absent playback IDs. Explicit presence assertions keep the fixture tied to concrete playback evidence. `Abby voice gateway actual playback identifiers current type and regression correction` passed TypeScript, all 17 gateway/voice cases without skips and diff check in 37s. Logs: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791008344330.log` and `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791008558320.log`.
- `Abby registered proposal manifest governance trace and complete focused PostgreSQL voice gate` passed **36 complete-file checks with zero failures/skips**, including registration/trace contracts, existing reference/cross-mode booking, new PostgreSQL conformance, eleven memory cases and six voice journeys, with four file workers. Command: `bash scripts/with-postgres.sh bash -c 'npm run db:migrate && node --test --test-concurrency=4 test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts test/composition/reference.test.ts test/composition/cross-mode-appointment-proposals.test.ts test/composition/cross-mode-agent-conformance.test.ts test/text/agent-appointment-proposals.test.ts test/voice/agent-appointment-proposal-call.test.ts'`. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791009352276.log`. The [direct maintainability review](AGENT_APPOINTMENT_PROPOSALS_REVIEW.md) has no remaining substantive finding; complete release and parallel gates are still required.

The gateway-to-voice-session contract and registered local release are verified. Publish the complete change after recording the evidence; broader signed ingress, buyer integration and real carrier evidence retain their own existing gates.

## Final local release — 2026-10-03

`Abby agent proposal 558b66a complete local release and mapped parallel isolation` **passed, exit 0, 51m11s**, with source frozen at `558b66aa9e1c79dbe4f0fd3158a71b7d8071031c`. It ran `npm run typecheck`, `ABBY_LEDGER=memory npm run test:text`, `npm run probe:postgres`, `npm run test:browser`, `npm run test:settings-isolation` and `ABBY_LEDGER=postgres npm run test:settings-isolation:postgres`, with exact-source, generated-type and diff checks before/after.

- Memory: **724 passed**, zero failed; 39 PostgreSQL/live-only cases skipped in this stage.
- PostgreSQL: **1,197 passed**, zero failed; one opt-in live-provider case skipped. Migration up/down/up, populated upgrades and actual Kanel generation passed without generated drift.
- Browser: **72 journeys passed** with the existing two workers. The separate Node/browser scheduling coordinators passed.
- Representative setting isolation: **18 checks across six files**, individually and in both four-worker dispatch orders.
- Complete mapped isolation: **517 Node checks across 60 files** and **59 browser journeys across 12 files**, each alone and in forward/reverse order with four Node or three browser workers. Every mapped run has zero failures/skips; both mapped coordinators also passed.

Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791009772311.log`. This closes the local D2 proposal-gateway gap. It does not prove a production buyer, Cliniko mutation safety or carrier behavior. Strict standalone patient actions remain unavailable.

A final documentation audit found the Markdown overview still at version 1.68/257 IDs despite the tested JSON registry at 1.71/261. An added contract assertion reproduced that mismatch; synchronizing the overview and checking version/count in the existing contract prevents this particular drift. Publication-source documentation validation is separate from the full release above; production and remaining runtime/test inputs must remain identical to that tested source.

Publication documentation validation passed `node --test --test-concurrency=4 test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts`: **two checks, zero failures/skips**. A diff against `558b66a` confirms production code, scripts, dependency/registry inputs and all other runtime fixtures remain identical; only documentation and the new overview metadata assertions changed after the full release. `git diff --check` passed.
