# Current-source clinic trial checklist, 6 November 2026

This prepares the supervised exercise required by [execution stage 11](EXECUTION_ORDER.md#11-complete-combined-qualification-and-activation-acceptance). Engineering baseline: actual merged Abby main `463a4ac3104c329f1dd39d2ed08f6e478aeddeea`, with [four passing CI jobs](https://github.com/garthtrickett/abby/actions/runs/41999130934). Before a trial, prepare the worksheet from the **actual deployed candidate commit**, not this historical baseline. The [operator acceptance proposal](MANUAL_ACCEPTANCE_PROPOSAL.md) and [worksheet command](CLINIC_SETUP_AND_REHEARSAL.md#rehearsal-worksheet-command) govern the exercise; this page identifies the observations to arrange. It records no staff approval or completed scenario.

The existing Cliniko demo account is the target for a patient-free rehearsal.
On merged main `8c0eb25f`, a bounded read-only catalogue check passed with one
business, one practitioner, two appointment types and nine metadata GETs. Its
inspected selection was unavailable because online booking was disabled. A
separate read confirmed the business still uses `Asia/Jakarta`; neither check
read patients or wrote to Cliniko. Private receipts are
`/home/gust/.local/state/abby-current-plan-20261106/cliniko-demo-catalogue-readonly-20261106.json`
and `cliniko-demo-timezone-readonly-20261106.json` in the same directory.

These checks refresh setup evidence, not approval of source, policy, staff or
payment work. Confirm the actual trial location and supported country (`AU`,
`UK`, `NZ` or `CA`) rather than labelling that timezone an Australian clinic.
Use only clinic-approved synthetic contacts and owned fixtures. Check exact
service/practitioner/location policy, booking/cancellation/rescheduling terms,
fee/waiver decisions, and confidential memo settings before any provider
action.

The worksheet requires six owner configuration areas: `catalogue`, `cancellation`, `rescheduling`, `payments`, `staff`, and `memos`. Record `null` for an absent area; never infer approval from a code default, a demo setting or a historical Karen value. Prepare a fresh mode-0600 owner-only binding with those six paths, the exact clinic/location scope and verified country. The command hashes decoded owner files and binds the current clean commit. Reprepare after any source, scope or policy change.

| Worksheet row | Staff observation to arrange | Current limit or missing input |
| --- | --- | --- |
| `catalogue` | Confirm approved service, practitioner, duration and location against current Cliniko readback. | Clinic owner approves the exact public catalogue. |
| `booking` | Request one synthetic appointment; compare played terms and exact acknowledged native appointment. | Approved policy, staff observer and current grants required. |
| `cancellation` | Cancel an exact owned fixture; verify native state and any notice-window handling. | Current clinic cancellation terms required. |
| `rescheduling` | Move an exact owned fixture; inspect old and new native facts and partial-result wording. | Current clinic rescheduling terms required. |
| `deposit` | Compare quoted amount/currency and any Stripe link to approved current fee policy. | A sandbox link or paid state does not approve clinic fees. |
| `payment-uncertainty` | Review a deliberately uncertain payment without duplicate collection or a false paid claim. | Cash/bank recorded-payment invoice exercise is owner-deferred; leave that specific rehearsal pending. |
| `staff-handoff` | Verify the named primary receives and explicitly acknowledges a synthetic review. | Confirm a clinic-approved alert destination and a real staff actor. |
| `backup-handoff` | Withhold primary acknowledgment, observe practice-manager or senior-receptionist backup acknowledgment. | The agent-operated demo passed separately; nominate a real backup for human acceptance. |
| `unresolved-request` | Show an unanswered request remains visible and owned through recovery. | Transport acceptance alone is not staff receipt or resolution. |
| `memo-content` | Inspect a confidential Cliniko communication memo for only verified administrative facts on the exact patient. | Clinic approves wording, native subject and API author policy. |
| `memo-access-retention` | Verify intended viewers and retention; check withdrawal or wrong-subject refusal. | Clinic approves access and retention; treatment/appointment notes remain separate. |
| `cleanup` | Independently read fixture outcomes and remove only the owned synthetic records; record any unresolved state. | Cleanup has a named human owner and protected evidence reference. |

Outbound [contact-review acceptance](OUTBOUND_STAFF_REVIEW.md#clinic-observations-still-required) is a separate scoped exercise. Staff must be able to find the clinic-owned pending review, while unresolved contact remains blocked; opening or closing the task cannot establish a whole-call no-stop result or grant reconsent. The twelve-row worksheet does not score this separate contact decision, and no such staff observation is recorded here.

For each actually observed row, the staff worksheet stores only `passed` or `failed`, an opaque observer reference, time and a private evidence reference. Leave unrun rows `notRun`; do not copy prior synthetic or agent-demo results into them. The CLI's `observationsRecorded` status is self-reported evidence only and always has `activationAuthorized:false`. Keep the protected native observations in the clinic-approved private destination. The failed acoustic gate, human policy/sign-off, real sender and provider acceptance, and activation decision retain their separate gates.
