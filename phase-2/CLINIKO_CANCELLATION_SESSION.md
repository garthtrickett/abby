# Standalone admitted cancellation composition

## Purpose and status

`src/standalone/cliniko-cancellation-session.ts` joins the existing email verifier, public approval sources, protected target authority and reviewed cancellation host. This supplies trusted local call-owner wiring. The live runner still leaves patient-specific standalone actions unavailable. All executable fixtures use synthetic provider, mail and independent clinical permission; no approval, delivery, staff receipt or production activation is inferred.

D-06/D-11 storage, D-07 supervised review and D-16 best-effort limitations remain unchanged. Email possession still does not establish independent patient self/proxy/minor permission. D-17 selects email OTP, while a real delivery service and permission source remain required.

## Construction and ports

| Function | Input | Output and owned work |
| --- | --- | --- |
| `ClinikoCancellationSession.create` | Actual admission receipt, authenticated inbound, session/version, SAM ledger/policy ports, clinic phone-index lookup, independent permission, delivery and aggregate verification budget, current admin directory, two owner approval files, provider selection and **one mandatory shared API-user budget**, close signal | Typed `cancellationSessionUnavailable` or one transient owner. Captures caller and cancellation policies; creates contact reader, `CallerVerificationSession`, `ClinikoCancellationAuthority`, recall writer, cancellation writer and `ClinikoCancellationHost`. Any failure/timeout/abort clears partial ownership; late captures cannot create a usable owner. |
| `beginVerification` | None | Immediate generic wording; begins at most one challenge. Delegates to the verifier; caller-provided email is not accepted. |
| `submitCode` | Dedicated secret input | Generic verified boolean. Delegates only to the verifier, outside caller turns, transcripts, model context and agent schemas. |
| `verified` | None; trusted owner only | Current operation-bound proof reference/expiry or absent. Rechecks caller/session, method and fee approvals, execution/staff declaration and independent patient permission/contact. The grant never belongs in caller/model progress. |
| `appointments` | Trusted port getter | Actual call-scoped protected `list/select/resolve` adapter. Wire into the existing TextReception/voice owner; follow its SAM played numbered-choice gates. Raw provider IDs are not choices. |
| `effects` | Trusted port getter | Actual reviewed one-attempt cancellation host. Existing SAM dispatch, played confirmation, affirmative turn and final checks govern sends. No fee charging, staff assignment or notification guarantee is added. |
| `dispose` / lifetime abort | Call close, disconnect, shutdown or explicit trusted close | Closes verifier/proof, target selections, prepared mutation and review runner. Retained ports fail closed. A possible already-sent request remains unknown, without retry or compensation. |

The factory does not invent admission, grant patient authority, enable settings, expose agent code-entry commands, drive playback acknowledgments or establish actual staff review. The existing trusted call owner must drive SAM/gateway commands and connect its lifetime signal. Supplier ports retain their own limits and abort contracts. Construction has a whole 15-second bound by default, with configurable 1–20,000 ms fixture bound; selection/verification and review/send keep their existing bounded operation deadlines.

## Budget and privacy

The supplied provider budget covers every fresh contact, appointment list, business/target check, recall and cancellation request. The composition does not create separate per-adapter default budgets. The deployment owner must bind the same coordinated API-user budget across calls and processes; a process-local test counter is not that deployment proof. E2E-278 supplies the actual PostgreSQL provider and verification budgets for its integrated and killed-worker paths.

Everything patient-specific remains volatile or Cliniko-owned. Public method/fee files and clinic-admin membership contain no patient approval fields. PostgreSQL stores aggregate request/verification limits only for these fixtures. Call, action, review, email, OTP, proof, target, times and outcomes are absent from database and backup canaries. A full recall POST is not staff receipt and marking recalled via API is not an acceptable human witness.

## Executable evidence

E2E-278 covers the composed text gateway journey from actual inbound/SAM admission and dedicated code entry to protected list, played numbered selection/confirmation, review before send and one inspected cancellation. It also checks shared reservation accounting, cross-admission/configuration denial, current setting/write-stop/policy/member/permission/session revocation, uncertain responses without replay, cancellation of pending mail/target work and abandoned factory results.

The PostgreSQL case uses generated Kysely database types, migrations, aggregate budgets and actual row/backup canary scans. The process test keeps the earlier reference owner and adds this composition: SIGKILL before recall acknowledgment, during clinical send and after the clear inspected result. A fresh process gets only public provider configuration and scans the full dedicated recall type; it performs no new provider mutation and never recovers the old call/proof/selection state. These are synthetic provider crash observations, not a proven Cliniko concurrency/notification contract.

## Remaining activation work

1. Choose/configure the email service and prove delivery, failure, expiry and secret entry through the actual caller transport.
2. Establish a real clinic-approved independent patient permission source, including supported self/proxy/minor restrictions. Do not infer this from email possession, phone lookup or public owner files.
3. Obtain actual clinical approval for method/fee/reason/notification policies; disabled templates remain disabled.
4. Complete the pending human Cliniko UI review witness. Demo primary is Garth Trickett; inspect after each synthetic test and before another write test; pause when unavailable. Production additionally needs approved backup, cadence, coverage and escalation.
5. Integrate the factory into the actual voice caller owner under those activation gates and repeat lifecycle/revocation/secret-entry E2Es. Telephone/carrier and actual provider side-effect checks remain required before voice write activation.
