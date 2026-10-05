# Supervised Cliniko staff-review rehearsal

This owner-run demo exercises D-07 with a synthetic patient and the current version-2 review envelope. It creates no appointment, sends no clinical mutation, contacts no patient, and does not enable caller writes or handoff. It uses the dedicated recall type **Abby supervised review rehearsal** and synthetic patient **Abby ReviewRehearsal**. Only Cliniko owns the patient, request marker and notes; Abby prints aggregate counts and fixed failures.

## Demo responsibilities

Garth Trickett is the primary reviewer. Review the full dedicated type after each synthetic test and before another write test. Pause testing if he is unavailable. No backup has been nominated; no other person's acceptance is invented. An unattended clinic rollout still needs a named backup, hours, cadence and escalation approval.

A successful recall POST proves saved provider work. A provider `recalled` flag proves observed status. Neither establishes that a human received, understood or resolved the request. The actual human report/notes inspection and acknowledgment below remain separate evidence.

## Operator commands

Use the owner-only local secret file and opt in explicitly. These commands do not accept credentials as arguments:

```sh
ABBY_LIVE_CLINIKO_EVAL=1 node scripts/rehearse-cliniko-review.ts prepare --secret-file=/home/gust/code/abby/.env
ABBY_LIVE_CLINIKO_EVAL=1 node scripts/rehearse-cliniko-review.ts status --secret-file=/home/gust/code/abby/.env
ABBY_LIVE_CLINIKO_EVAL=1 node scripts/rehearse-cliniko-review.ts cleanup --secret-file=/home/gust/code/abby/.env
```

Run long commands through `work run` and observe them through `work wait`. `prepare` creates at most one type, one synthetic patient and one recall per invocation, with no automatic retry. A fresh `status` process scans bounded account/type state and exercises the production recovery reader; it is given no saved patient ID, marker, request or previous process memory. Existing patient/request work prevents another setup POST. No command marks work recalled on staff's behalf.

On `uncertainSetup`, stop further mutation rehearsals and inspect Cliniko. A subsequent empty scan does not prove that the request failed. Do not rerun `prepare` to recover a lost response. More than 500 active records in a scanned resource, incomplete scans, duplicate fixtures, changed fixture metadata or invalid envelopes fail safely; this is a bounded demo tool rather than a production queue monitor.

## Human rehearsal

1. Open Cliniko **Reports → Recalls**. Include the current clinic date and select **Abby supervised review rehearsal**. Include every practitioner and business; no last-visited-business filter may hide requests.
2. Find **Abby ReviewRehearsal**, then open the patient's **Recalls** tab and read the notes. Confirm the envelope is version 2, is labelled `demo.reviewOnly.noAppointmentSend`, and instructs staff not to replay automatically. This is a fictitious booking intent; there is no appointment to execute.
3. Mark the item recalled only after this inspection. Report whether the entry and complete notes were actually visible and whether marking it recalled worked. Do not paste patient IDs, request markers or full notes into chat.
4. Run `status` again in a fresh process to observe the provider flag, then `cleanup` after evidence is recorded. A marker alone is never a received/resolved staff-task claim or permission to dispatch an appointment write.

Cliniko documents the [Recalls report and recalled checkbox](https://help.cliniko.com/en/articles/1023943-recalling-patients) and [recall notes in the patient profile](https://help.cliniko.com/en/articles/8410284-set-up-patient-recalls). Actual account permissions and visibility must be witnessed in this rehearsal.

## Cleanup and evidence limits

Cleanup verifies exact synthetic name/reference, dedicated type metadata, scope/credential/policy bindings and bounded active records. It refuses edited contact data, any appointment associated with the synthetic patient, foreign patient recalls, invalid envelopes and ambiguous fixtures. Before each archive, a fresh exact read must match the observed ownership fields and revision. Archive the recall, then patient, then type, verifying each archive independently. If an archive fails or its result cannot be verified, stop; do not continue to the next resource or start another rehearsal until the account has been inspected.

Do not edit or reuse rehearsal fixtures for other work during cleanup. Cliniko offers no proved atomic compare-and-archive protection; an external edit after the last check remains a demo coordination risk. Archived provider fixtures remain in Cliniko; this is not hard deletion. The CLI writes no local patient-specific state, report file, replay key or artifact. Partial setup and uncertain cleanup need owner inspection; this tool is not a production first-time intake recovery design.

E2E-271 covers synthetic preparation, fresh account/type-only status, outside staff-status observation, cleanup ordering and ownership failures, unknown sends, bounded scans, no appointment mutations and generic CLI output. Live provider persistence and an actual staff UI witness are recorded separately in `phase-0/CLINIKO_EVIDENCE.md`; local proof does not substitute for either.

## Current rehearsal evidence

On 2026-10-04, C-LOCAL-60 passed typecheck and 16 parallel checks with zero skips. C-LIVE-54 completed the actual provider create/fresh-status/verified-archive round trip, then provisioned a new separate UI fixture. One synthetic pending item currently remains under the type above, due 2026-10-04. Garth’s human report/notes inspection is pending; after that witness, observe status and archive the fixture through the cleanup command. No API staff acknowledgment or appointment mutation was sent.

C-LIVE-56 rechecked the account on 2026-10-04 using a fresh `status` process on source `ea83d8eb2a915e54aa5775bb3652fe82b952c7df`: one exact type, one synthetic patient, one pending item, zero provider-marked-recalled, invalid or ambiguous items and zero clinical writes. The human report/notes inspection remains pending. This read did not prepare, acknowledge, archive or resend anything.

On 2026-10-05, another fresh `status` process on merged source `270673eb271656ca011486c34acea01523e7b840` observed those same counts. Tracked job `Abby fresh demo recall status while awaiting browser attachment`, log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791180102395.log`, completed exit 0 in two seconds. No fixture was changed. Paseo browser tools have no connected host, so the owner authorized the local Browser Drive fallback. An isolated task-owned browser/profile on port 9335 reached the account's direct sign-in, accepted the previously supplied demo password and requested an email verification code. UI inspection, acknowledgment and cleanup remain pending that code; no API acknowledgment substitutes for the UI witness. Any eventual agent-operated inspection must be recorded as such, without claiming a human staff member received or resolved the request.
