# Clinic setup and observed rehearsal

This implements the reusable setup patterns found in the supplied Karen
reference. It builds on Abby's existing catalogue, financial, staff-review and
confidential memo owners. It adds optional cancellation/rescheduling notice
windows and a local rehearsal worksheet. No source clinic's settings are
imported, and no runtime permission is granted by completing this worksheet.

## Existing owners and the values to configure

| Area | Existing Abby owner | Clinic values |
| --- | --- | --- |
| Services and practitioners | `OwnerFileServiceCatalogue`, `OwnerFileBookingCatalogue`, `ClinikoCatalogueSetup` | Exact location, services, initial/follow-up durations, eligible practitioners and explicit exclusions. Sync or discovery cannot approve additional services. |
| Deposits | `OwnerFileFinancialFeePolicy`, existing Stripe preparation/settlement owners | An explicit `notRequired` policy or approved amount/currency, eligible selection, payment window and terms. Missing policy is unavailable. Required clinical expiry has separate authority; no unpaid-booking cancellation default is introduced. |
| Staff handoff | `OwnerFileStaffPolicy`, `OperatorAlertWorkflow`, native Cliniko review queue | Clinic mailbox through the existing delivery port, actual owner and distinct backup accounts, cadence and escalation. The owner chose practice manager as backup role, with senior receptionist fallback. Transport acceptance, responsibility acknowledgment and completed patient work remain different. |
| Private records | Existing administrative memo/native permission owners | Verified administrative facts, confidential Cliniko communications, exact permitted viewer/author and record retention decisions. Existing appointment and treatment notes remain untouched. No full transcript memo is introduced. |

The catalogue-to-fee path already selects exact current service/practitioner
terms; do not add independent pre-call/post-call deposit decisions. Staff
unresolved-work tracking and explicit backup acknowledgment already exist.
Their deployment values should be supplied to those owners, not to a parallel
notification or patient database. The existing Cliniko demo account remains
the rehearsal target; a new clinic is not a prerequisite for local work.

## Optional notice windows

Cancellation and rescheduling owner files may add `noticeRanges`, containing
one to three entries. Each entry has exactly `withinHours` (integer 1–168),
`handling` (`automatic` or `staffReview`) and `terms` (the existing
`version`/`approvedText` pair). Hours and range terms versions must be unique;
range versions must differ from the standard terms version. Text keeps the
owning policy's existing limit: 2,048 characters for cancellation, 500 for
rescheduling. The policy, scope, current administrator and file-revision checks
are unchanged.

Example of the additional field only; these are illustrative settings, not
an approved clinic policy:

```json
{
  "noticeRanges": [
    {
      "withinHours": 24,
      "handling": "automatic",
      "terms": { "version": "notice-24-v1", "approvedText": "The clinic's approved late-change terms." }
    },
    {
      "withinHours": 3,
      "handling": "staffReview",
      "terms": { "version": "notice-3-v1", "approvedText": "Please contact the clinic about this change." }
    }
  ]
}
```

The narrowest matching window wins, regardless of file ordering. A window is
strictly less than its threshold; exactly 24 hours is outside a 24-hour window.
Outside all configured windows the existing standard terms apply. When ranges
are present they replace the old single late-window calculation; keep existing
legacy fields in the file for the unchanged schema and older deployments.
Omitting ranges retains the original two-term policy.

Both policy owners use the same calculation. Individual cancellation's shared
appointment selection and class cancellation therefore see the same range
terms. Current authority and terms are still checked before effects. An
automatic range permits neither charging money nor skipping caller consent.
A `staffReview` range produces no automatic clinical terms: the existing
unavailable/direct-contact path applies. It does **not** save a staff request,
send an alert, promise a callback or claim that the appointment was cancelled.
Saving a review still requires the existing independent review workflow.
No reason-based fee waiver or free-reschedule-day rule is inferred. Those
require a separately represented current clinic decision; existing financial
waiver records remain the authority for money.

## Rehearsal worksheet command

Create an owner-only JSON file outside Git, for example
`/absolute/private/clinic-setup.json`, mode 0600. Use the actual deployment's
five public-policy/configuration files; use `null` for any area not configured.
These paths are inputs only, not copied into the worksheet or command summary.
Do not point at `.env`, patient records, recordings or financial work records.
The files are bounded owner-only JSON, not evidence of valid runtime approval.
Existing owners must still validate their schema, current grants and lifetime.

```json
{
  "schemaVersion": 1,
  "scope": { "tenantId": "clinic-tenant", "clinicId": "clinic", "locationId": "main" },
  "country": "AU",
  "files": {
    "catalogue": "/absolute/private/services.json",
    "cancellation": "/absolute/private/cancellation.json",
    "payments": null,
    "staff": "/absolute/private/staff.json",
    "memos": null
  }
}
```

Country must be AU, UK, NZ or CA. Run from the desired committed checkout;
tracked edits and untracked files other than the shared `node_modules` link
are refused. Ignored build outputs are not used to bind the source.

```sh
npm run clinic:acceptance -- prepare --config=/absolute/private/clinic-setup.json --out=/absolute/private/rehearsal-v1.json
npm run clinic:acceptance -- check --config=/absolute/private/clinic-setup.json --report=/absolute/private/rehearsal-v1.json
```

Prepare never overwrites an existing report. It creates twelve `notRun` rows:
catalogue, booking, cancellation, rescheduling, deposit, payment uncertainty,
staff handoff, backup handoff, unresolved request, memo content, memo access and
retention, and cleanup. The source commit, clinic/location, country and hashes
of the five decoded configuration files are bound to the worksheet. Capture
rereads configuration and source to reject changes while preparing it.

After an actually observed exercise, staff may edit its row to `passed` or
`failed` with an opaque `observerRef`, canonical UTC `observedAt` at or after
preparation, and a private evidence-store reference `evidence-` followed by
16–64 lowercase hex characters. Use neither patient/native IDs, addresses,
names, transcript text nor URLs as references. No free-text field is accepted.
Unrun rows keep all three observation fields null. A failed, omitted, skipped,
duplicate, future-dated or malformed row cannot count as a complete worksheet.

Check prints only fixed statuses, aggregate counts and missing area names.
It returns `stale` if source, scope, country or any configuration changes;
start a new worksheet and repeat the affected acceptance exercise rather than
copying old passes. A missing area remains `configurationIncomplete`, never
an assumed no-deposit or approved memo policy. Prepare exits 0 after creating
the worksheet; check exits 2 for incomplete/stale/failed/unavailable observations
and 0 only for `observationsRecorded`. Invalid command/file access exits 1.

These are explicitly **self-reported staff observations**, not authenticated
staff identity, independently verified native outcomes or human sign-off.
Every summary has `activationAuthorized: false`. The worksheet cannot enable
voice, release contact, send payments/mail, create a memo or change any native
appointment. It complements the existing [operator acceptance proposal](MANUAL_ACCEPTANCE_PROPOSAL.md)
and [operator acknowledgment workflow](../deploy/voice/OPERATOR_RESPONSE.md).

## Observations to retain

For each row, retain detailed protected evidence only in the clinic-owned
destination referenced by the opaque evidence ID. Confirm the selected service
and practitioner, exact native booking/cancellation/move result, deposit and
unknown-payment behavior, primary/backup acknowledgment and unresolved-work
visibility, confidential memo facts/viewers/retention, and fixture cleanup.
Inspect Cliniko outcomes directly; a log entry or recorded phone call does not
prove the requested mutation completed. A deployment's failed speech gate,
missing provider key or unexecuted real rehearsal stays visible separately.
Ordinary local development and CI do not wait for real-patient activation.
