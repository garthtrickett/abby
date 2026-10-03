# Agent appointment and patient-intake proposals

## Status

Local implementation closes a D2 gateway gap: cancellation, rescheduling and intake were supported by the reception core and voice composition, but had no schema-defined agent proposal commands. No new patient action is enabled in standalone Cliniko. Registration, final typecheck, whole-call voice integration and broad/parallel release remain open.

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

`E2E-261` is reserved locally for this feature and not yet registered in the manifest. Eleven memory cases cover each operation's default/off/on capture, separate confirmation and single write, strict unavailable mode, schema/scope/session denial and missing host evidence. Two disposable PostgreSQL cases run the same gateway commands through strict standalone and authorized embedded compositions, including every operation's write stop, reconnect/replay behavior and standalone database/backup canaries.

Initial evidence is retained with corrections:

- The first memory run failed two appointment cases because its synthetic target omitted `endsAt` and `timeZone`. Correcting the target, without changing validation, passed eight cases with no skips. Logs: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007214309.log` and `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007296333.log`.
- The initial PostgreSQL/memory run passed ten complete-file cases without skips, including actual backup scans. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007518390.log`.
- Initial typecheck rejected undeclared precondition names and an unsupported memory booking-mode argument. The correction uses declared preconditions and leaves booking disabled in the memory fixture; the actual strict PostgreSQL host still supplies unavailable booking and patient modes. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007518181.log`.
- The expanded regression initially failed the exact discovery expectation and three pre-existing PostgreSQL cases because its base database had not been migrated. Adding the new command IDs to the discovery expectation preserves exactness; migrating the disposable base database restores its required setup. The corrected run passed **28 checks, zero failures/skips**, across the reference gateway, existing cross-mode booking, new proposal conformance and eleven new memory checks, with four file workers. Logs: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007649340.log` and `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007762561.log`.
- `Abby agent proposal precise catalogue type and current toggle typecheck correction` passed TypeScript and diff checks in 1m48s on these implementation and test inputs. Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791007762012.log`.

The existing voice journeys must be connected to these commands before claiming whole-call gateway coverage. Then register the commands and scenario evidence, update the agent contracts and work plan, run final release/parallel gates, and publish the complete change.
