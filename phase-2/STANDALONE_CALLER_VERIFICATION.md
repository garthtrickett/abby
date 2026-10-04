# Standalone caller verification composition

**Status:** locally implemented text composition, with synthetic mail, registered contact and patient/action permission. Production caller capabilities remain unavailable. D-17 selected the method; it did not approve a clinic rollout. E2E-274/275 add dedicated code entry and current operator approval to the existing E2E-269/273 verifier/proof foundation.

## Boundaries

One trusted call owner creates `CallerVerificationSession` after admission. Its authenticated inbound event must match the receipt's provider/account/call and dialed number. The presented phone number comes only from that event; it remains an untrusted candidate clue. Missing/invalid numbers use the existing anonymous generic fallback and cannot construct this owner.

The session owns one operation, one email challenge, at most three code answers and one private proof. Codes enter `submitCode()` directly through trusted secret entry. They must never become a `FinalCallerTurn`, transcript, model argument, agent command, log or durable row. This patch supplies a trusted library seam and text tests; it does **not** route spoken answers or carrier keypad input into it.

`begin()` returns identical generic wording immediately, including when approval, candidates, registered email, permission or mail are unavailable. It starts one bounded owned task and never resends. A code answer arriving while delivery is pending waits for that task. Successful delivery-port acceptance does not prove mailbox delivery. Public answer results contain only `verified: boolean` and never reveal patient existence, recipient, token or proof reference. Failures do not identify which check failed. Timing of answers is not a constant-time privacy guarantee.

Current SAM lifecycle/session lease, bound admission, captured/current automation policy, operator approval and independent patient/action permission must still permit the operation. Write verification also checks the emergency write stop; approval and proof do not bypass the writer's separate execution setting, exact target/offer, fees, confirmation or staff-review gates. Protected proof uses recheck current registered contact, unique candidate, permission and the original challenge expiry. Shared numbers and representative callers remain denied. Three malformed or wrong code answers exhaust the challenge; concurrent answers do not allocate additional attempts or mint extra proof.

The call owner must call `dispose()` on disconnect, call end, fallback and teardown. It closes both verifier and proof and invalidates late results. Losing the process loses all challenge, token and proof authority; only the clinic aggregate budget survives. A new owner cannot restore them from the budget. No patient-specific persistence is added.

## Operator approval

`OwnerFileCallerPolicy.capture()` reads an absolute, bounded, regular owner-only JSON file without following the file's symlink. It resolves `approverRef` through the existing trusted `AdminDirectory`, requiring a current `clinicAdmin` in the exact location. It captures the public approval and full administrator membership in volatile hashes. Every use rereads both; replacement, revocation, role/scope/email/membership changes, expiry or emergency disable reject the captured call. A changed source requires a newly captured owner. These hashes are not patient-linked storage.

Only the exact schema below is accepted. Dates are canonical UTC instants; `approvedAt <= effectiveFrom < effectiveUntil`. Operations are unique known read/book/cancel/reschedule operations. The initial method fixes three answers, five-minute challenge expiry, denied shared/proxy handling and independent host patient permission. Expanding those controls needs a separate design and evidence update. The operation exposed by the gate must match the session operation; approval for reading cannot be injected as cancellation approval.

This is an **operator-provisioned** activation input, not a signature system or proof that an administrator clicked an approval UI. Filesystem ownership and trusted administrator provisioning establish its input boundary. An authorized operator must obtain and document the actual clinic approval/rehearsal before provisioning an enabled record. The record alone does not fulfill the complete rollout record in [the caller verification policy](../phase-0/CALLER_VERIFICATION_POLICY.md), establish patient/action permission, approve a staff workflow or activate a production capability. No API or agent command writes this configuration.

Example for review only; it intentionally stays unapproved and disabled:

```json
{
  "scope": { "tenantId": "demo", "clinicId": "clinic", "locationId": "main" },
  "revision": "verification-1",
  "approverRef": "clinic-admin",
  "approvedAt": "2026-10-04T00:00:00.000Z",
  "effectiveFrom": "2026-10-04T00:00:00.000Z",
  "effectiveUntil": "2026-10-05T00:00:00.000Z",
  "approved": false,
  "enabled": false,
  "method": "emailOtp",
  "maxAnswers": 3,
  "lifetimeSeconds": 300,
  "sharedNumbers": "deny",
  "representatives": "deny",
  "patientPermission": "independentClinicHost",
  "operations": ["appointments.read"]
}
```

Keep administrator provisioning separate from patient data. Unknown fields (including patient identifiers, contacts and free-text notes), malformed/oversized files, unsafe permissions, wrong scope and unknown methods/operations fail closed. Provision replacement files atomically. A generic typed failure reports unavailable configuration without logging paths, contents or underlying errors. The owning buyer can supply its own operation-bound policy gate and administrator directory; the core domain does not depend on local files.

## Function and call map

| Function | Inputs | Output | Calls / ownership |
| --- | --- | --- | --- |
| `readOwnerJson` | Absolute path, byte limit | Parsed unknown or generic failure | Bounded filesystem open/stat/read/close; shared with administrator directory |
| `OwnerFileCallerPolicy.capture` | File, scope, operation, captured policy version, directory, clock | `Result<gate, callerPolicyUnavailable>` | Owner reader → exact decoder → current administrator → second approval read; no patient lookup |
| `gate.current` | Exact scope | Enabled/version result or unavailable | Current approval → current administrator → fresh approval/time checks; no cached authorization |
| `CallerVerificationSession.create` | Admission/inbound/session, operation, SAM/current policy, approval, lookup/contact/permission/budget/mail ports | `Result<owner, verificationUnavailable>` | Validates transport/admission and operation binding → owns email verifier + transient proof |
| `owner.begin` | None | Fixed prompt immediately | Starts at most one bounded `EmailPatientAuthority.start`; retains and catches its private promise |
| `owner.submitCode` | Private code input | `{ verified: boolean }` | Wait owned challenge → `answer` → proof `issue` → fresh protected-use check; no caller-turn or model call |
| `owner.verified` | None; trusted host only | Private proof ref/expiry or absent | `verifyOperation` → current SAM/policy/approval/contact/permission; denial closes the owner |
| `owner.proof` | Trusted host wiring | Existing proof-host capability | Used by protected reader or cancellation guard, not public progress |
| `owner.dispose` | None | Void | Closes email and proof, clears grant and invalidates late work |

The text test carries the private proof into `CommandGateway.appointments.read.v1` → `TextReception` → `ClinikoAppointmentReader` → current proof checks → protected provider GET. It asserts zero appointment-detail reads before proof and after revocation. Code answers bypass that entire command/turn route. Any future voice owner must suspend ordinary transcription/model routing while receiving secret input, and demonstrate that in its own enabled/disabled E2E before connection to real callers.

## Verification and remaining gates

- E2E-274 covers actual gateway/SAM/protected-read composition, immediate generic wording, pending/late mail, wrong answers, cross-call isolation, expiry, changed policies/approval/membership/permission, disposal and PostgreSQL row/backup privacy. The new owner's PostgreSQL test proves fresh-object loss; E2E-269 separately proves the underlying verifier's actual SIGKILL loss with budget capacity remaining. Do not describe the fresh-object test as a process kill.
- E2E-275 covers exact operator approval, enabled/disabled whole text journeys, current approver membership, unsafe/missing/expanded files and replacement during held membership reads. Existing administrator-directory and magic-link behavior remain regression-covered after extracting the shared bounded file reader.
- Mail, contact, patient permission and actual clinic approvals in these journeys are synthetic. They do not prove a mailbox, human review, fee/consent policy, carrier voice path or live clinical activation.
- Open gates: selected email service and approved sender/retention policy; actual patient self/proxy/minor action-permission source; complete clinic approval/rehearsal; production call-owner integration and secret-input routing; existing independent appointment/staff execution gates. Production support remains `unavailable`.

`OwnerFileClinicApproval` now owns the shared bounded current approval/membership algorithm, with separate exact decoders for verification and [cancellation policy](CLINIKO_CANCELLATION_AUTHORITY.md). The caller gate retains its typed failures, operation scope, default denial and existing enabled/disabled behavior; E2E-274/275 are regression-run after the extraction.

E2E-278 adds a [trusted admitted cancellation composition](../phase-2/CLINIKO_CANCELLATION_SESSION.md): dedicated email-code secret entry, current method/fee/execution/staff declarations, one mandatory shared provider budget, protected played selection, SAM confirmation and reviewed one-send cancellation. It checks actual composed-owner SIGKILL before/during/after send, fresh discovery without replay and PostgreSQL/backup privacy. The production runner does not construct it; real clinical permission, email delivery, clinic policy approval, human staff witness and activation remain open.
