# Concrete cancellation authority and clinic policy

**Status:** local text implementation, E2E-276/277. This replaces fabricated target/fee authority in the cancellation journey with actual protected reader, opaque selection, provider metadata decoder and public clinic-policy file checks. Provider traffic, operator approval, mail and independent patient permission in the tests remain synthetic. Production patient actions remain unavailable.

## Appointment selection and target resolution

`ClinikoCancellationAuthority` implements the existing `AppointmentHost` and `AppointmentChangeAuthority` interfaces. One trusted call owner supplies its exact scope, call/session, captured policy version, provider configuration, operation proof and cancellation policy. Construction rejects mismatched business, credential fingerprint or policy. It owns no writer or proof issuance method.

1. `list()` verifies the **cancellation operation** proof and reads appointments through the existing bounded Cliniko reader. This permits only the protected disclosure necessary for that approved cancellation action; it does not create general read or other operation permission. Before proof or current public policy, no appointment detail GET occurs.
2. Current business timezone, proof, policy and listing epoch are checked again after the provider read. Validated appointments receive random opaque references. Maps live only in this call's process and are invalidated by another list or disposal. Invalid timestamps and ambiguous equal instants fail instead of producing indistinguishable options. Provider metadata/notes are discarded.
3. A single listed target establishes the call-local `selected` alias. Multiple targets require a one-time numbered choice from the first three options; the actual `TextReception.selectAppointment` path requires a played list before accepting that choice. `select()` fresh-resolves the exact target before establishing `selected`. The alias is not usable in another call or before a valid selection; raw provider IDs never select a target. The trusted owner can pass it into the existing appointment proposal command without exposing patient/provider IDs to model progress.
4. `resolve()` accepts only the bound cancellation operation, known live selection, exact proof/patient and current call/session/policy/time. It revalidates cancellation proof, current public approval, active business/timezone and the exact current individual appointment's patient/business/practitioner/type links, status and interval. A changed selected interval, foreign/malformed link, archive/cancellation/deletion or missing required status field denies resolution.
5. Public terms are selected for the current time, then approval and proof are rechecked. The selected mapping must still be current. Guard-level prepared provider comparisons additionally reject practitioner/type changes after proposal. All waits have a whole-operation timeout and abort/dispose handling; late results cannot restore disposed or relisted selections.

Selection resolves evidence only. The existing cancellation guard still checks active SAM session/lease, current/captured settings, exact played target/terms, separate affirmation and emergency stop. The standalone host still requires an acknowledged Cliniko-owned review and final authorization after provider edge reads/budget waits before its one possible PATCH. A later cancelled state is not an exact original-writer/fee/notification receipt. No replay or compensation is added.

## Current public clinic policy

`OwnerFileCancellationPolicy` reads an exact 8 KiB owner-only schema through shared `OwnerFileClinicApproval`. The shared module is also used by the email-method gate; it captures and rereads exact public approval plus current scoped clinic-admin membership without caching authorization. Source replacement, role/scope/email/member change, expiry, disabled/unapproved status and unsafe/missing files deny the existing call. No patient-bearing record, hidden digest store or configuration write endpoint is introduced.

Cancellation policy additionally binds the captured clinic policy version, business, credential fingerprint, review type and timezone. It must explicitly select `bestEffort` and Cliniko notification ownership. These are required declarations for this adapter, **not evidence** of provider fee/notification behavior or a functioning staff workflow. Real activation still requires those proofs and clinic acceptance.

The policy approves one cancellation reason and two public fee wordings with distinct versions. It selects late terms when notice is **less than** `lateNoticeHours`; exactly that boundary uses standard terms. Limits: whole hours 1–168 and advance days 1–90. Past, out-of-horizon or expired actions have no terms. Terms expire at the approval's fixed effective-until, so unchanged resolves do not manufacture different consent digests. A boundary crossing after confirmation changes the term version/text and blocks dispatch; the caller needs a new confirmation of the actual new terms. The adapter does not calculate invoices or charge fees.

The example is a review template. It is deliberately disabled/unapproved and uses placeholder public bindings/wording. No clinic has approved it:

```json
{
  "scope": { "tenantId": "demo", "clinicId": "clinic", "locationId": "main" },
  "revision": "cancellation-1",
  "approverRef": "clinic-admin",
  "approvedAt": "2026-10-04T00:00:00.000Z",
  "effectiveFrom": "2026-10-04T00:00:00.000Z",
  "effectiveUntil": "2026-10-05T00:00:00.000Z",
  "approved": false,
  "enabled": false,
  "policyVersion": "clinic-policy-1",
  "businessId": "1",
  "credentialFingerprint": "0000000000000000000000000000000000000000000000000000000000000000",
  "recallTypeId": "1",
  "timeZone": "Australia/Sydney",
  "writeContract": "bestEffort",
  "notificationOwner": "cliniko",
  "cancellationReason": 50,
  "lateNoticeHours": 24,
  "maxAdvanceDays": 90,
  "standardTerms": { "version": "standard-1", "approvedText": "Clinic must supply its approved standard cancellation terms." },
  "lateTerms": { "version": "late-1", "approvedText": "Clinic must supply its approved late cancellation terms." }
}
```

The file contains only public clinic configuration. Unknown patient/contact/note fields, extra nested terms fields, malformed values, unapproved ownership modes and invalid dates/zones are rejected. Each wording is limited to 2,048 characters and the whole file to 8 KiB. An authorized operator supplies actual generic clinic wording, current administrator provisioning and complete clinic approval/rehearsal. The file alone neither proves human approval nor supplies patient self/proxy/minor consent. Independent patient/action permission remains mandatory. Operators replace public files atomically; changed approval requires a new captured call/source.

## Function and call map

| Function | Inputs → output | Implementation calls |
| --- | --- | --- |
| `OwnerFileClinicApproval.capture/current` | Exact decoder, file, scoped directory/time → captured source / current approved value or denial | Bounded owner JSON → decoder → current clinic admin → second file read → captured approval/member/time checks |
| `OwnerFileCancellationPolicy.capture/current` | Provider/clinic binding and public source → policy/current approval or typed failure | Shared source plus exact business/credential/type/zone/policy comparisons |
| `termsFor` | Current validated approval, target start, time → applicable immutable terms or absent | Horizon/expiry/notice checks; this pure projection grants no authority |
| `ClinikoCancellationAuthority.create` | Bound call, proof, provider config and policy → adapter or invalid configuration | Checks exact policy/writer selection bindings; no patient lookup or send |
| `list` | Scope, proof ref, range/time → protected snapshot with opaque refs | Current policy → cancellation-proof projection into existing Cliniko reader → fresh policy/proof → bounded volatile selection map |
| `select` | Scope, proof ref, number/time → one fresh snapshot or denial | Consumes prior choice → fresh `resolve` → call-local `selected` alias; SAM independently requires played options |
| `resolve` | Bound target selection, verified patient, proposal/commit and abort → exact target/terms evidence or typed failure | Current proof/policy → budgeted business and target GETs → exact decoder → terms → final approval/proof/mapping checks |
| `dispose` | None → closed selection owner | Abort outstanding work, clear map/choice, invalidate pending listing epoch; call owner separately disposes host/verifier/proof |

The owning buyer continues to implement the existing appointment authority/host interfaces using native diary and clinic-policy sources. This standalone adapter's file/Cliniko details do not enter the core SAM or change the atomic owning-host contract.

## Evidence and release limits

E2E-276 exercises actual proof → protected list → opaque/played numbered choice → current target/terms → SAM played confirmation/affirmation → acknowledged review → one inspected cancellation. It checks cross-call/relist/raw-ID denial, stale target/link/status/business/zone responses, policy/member changes after confirmation, lost/held work, disposal and actual database/backup privacy. E2E-277 checks the public decoder, bindings, disabled policies and a fee-boundary crossing after played confirmation. Existing caller approval/code-entry, cancellation and embedded/read regressions run after extracting shared approval handling.

These tests do not establish actual clinic approval, independent real patient consent, mail delivery, human review, provider fee/notification side effects or a final production owner/voice path. Final composition process-loss/stop/selection/call E2Es and controlled actual provider lifecycle remain required before activation; previous underlying verifier/cancellation crash proofs are useful evidence, not a claim that the new final composition is deployed. Booking, rescheduling and pre-patient intake remain separate following steps. The full nine-step goal remains open.
