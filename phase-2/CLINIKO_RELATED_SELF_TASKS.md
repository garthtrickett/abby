# Returning to the caller after helping a related patient

A verified native patient caller can explicitly request a booking for themselves
after completing an approved booking for a related patient. Abby starts a fresh
caller verification and requires a new played confirmation. The related patient's
original booking and receipt remain separate and cannot replay.

This is selected gap-9 coverage under [stage 6 of the execution order](EXECUTION_ORDER.md#6-requalify-composed-flows-and-address-earlier-gap-engineering),
using stable scenario `E2E-387`. It does not create a general representative grant.

## Current authority and private input

An ordinary “book another appointment” request cannot silently change subjects.
The bounded explicit caller phrases, such as “Book an appointment for myself”,
produce a routing marker locally. The model response schema cannot supply that
marker. It contains no patient identity, channel, code, proof or permission.

Leaving a related subject requires the existing independently verified-patients
task approval, a settled prior task, a remaining task slot, current clinic and
administrator approval, and the pinned native caller. The new task uses its own
operation approval, patient permission and registered-email challenge. The old
subject's proof, offer, code owner and consent do not authorize it. A separate
non-patient guardian record cannot become a native caller-patient identity.

Preparation leaves the previous owner intact until the workflow event commits.
Activation rechecks cancellation and ownership after its last awaited approval.
An unaccepted abort preserves the prior task; an accepted event with failed
activation reserves its slot, retires obsolete authority and requires fresh
verification. The existing task limit and unresolved-action refusal remain.

The private representative input delegates back to its original caller keypad
only when CallFlow identifies that exact retired representative root and its
currently activated native successor. Missing or negative handoff approval,
unrelated disappearance and closure remain failures. The handoff clears the
private field buffers and stops their transcription; native code entry opens
neither private-field nor ordinary transcription. Patient verification and
permission still belong to the current native workflow.

## Local qualification and retained failures

The current 22 focused controls pass with zero skips: 14 caller-task controls,
three new private handoff controls and five inherited private-input controls.
They cover fresh proof and separate native subjects/receipts, ambiguous requests,
forged model markers, withdrawn approval/membership/permission, changed caller
candidates, task limits, unresolved actions, aborted preparation, failed activation,
guardian refusal and ordinary same-caller progression. A final-approval abort
control first failed and then passed after the actual activation correction.

Whole strict TypeScript and the fresh 758-output serving graph pass. The two
actual emitted, signed HTTP/media, real clinical-host PostgreSQL cases pass:
related booking then native-self booking, and native caller permission withdrawn
after the second readback but before consent. They retain native 180 requests per
minute, shared SQL verification limits and a real elapsed quota window using
ordinary hold/presence turns. No lease, action deadline or quota was increased.

Public projections, every-column scans and complete unfiltered SQL backups reject
private fields, codes and transient proof references. The full backup restores,
the scans pass again and unrelated retained rows remain exact. Each case and its
outer server clean up their owned databases, container, anonymous volume and
socket parent. These checks passed with zero skips.

The first signed rehearsal failed before the return route after a silent quota
wait. The revised hold/presence rehearsal then exposed an actual transport defect:
removing the completed related owner stopped the underlying keypad and entire
call. A separate direct private-input witness reproduced that failure. Both
failed runs and the failed witness remain retained; the explicit activated-owner
handoff fixes the observed defect. Interim artifacts and source snapshots remain
preserved. The direct-SQL sampler registers only this new exact test filename;
its isolation guards, pre-issue sampling and all privacy assertions remain.

## Remaining scope

The positive signed evidence covers one fixed, approved individual-service booking
composition. Caller routing also recognises the existing individual cancel, move
and enquiry operations, but their related-to-self compositions and broader
catalogue combinations are not established by these two cases. Classes, financial
work, registration, corrections and resends gain no representative authority.
Outbound task sequencing remains outside this inbound configuration.

Full-call evidence, actual clinic authority and record provisioning, staff duty,
access/retention, carrier/acoustic acceptance and deployment remain separate.
Local results do not complete the original execution plan. Independent review,
normal parent integration, exact-head CI and actual-main qualification are still
required before delivery.
