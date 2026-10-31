# Booking for the caller and a related patient

A verified native patient caller can complete a booking for themselves and one
approved related patient in either order. Explicitly returning to themselves
after a related booking starts fresh caller verification and played confirmation.
Starting with their own booking then selecting a related patient requires new
actor and patient proofs. Each booking and receipt stays separate and cannot replay.

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
activation reserves its slot, retires obsolete authority and requires a fresh
explicit request and verification. The existing task limit and unresolved-action refusal remain.

The private representative input delegates back to its original caller keypad
only when CallFlow identifies that exact retired representative root and its
current native input owner or an idle recovery state after accepted-but-failed
activation. Idle recovery grants no activation or proof, and a fresh native request
can be prepared before private input next observes idle. Missing or negative approval,
unrelated disappearance and closure remain failures. The handoff clears the
private field buffers and stops their transcription; native code entry opens
neither private-field nor ordinary transcription. Patient verification and
permission still belong to the current native workflow.

## Original caller-component qualification and retained failures

Source qualification covers 25 controls: 15 caller-task controls, five private
handoff controls and five inherited private-input controls. The prior 24 passed
with zero skips; their bodies remain exact after adding the separately passed
caller-first case. This is retained evidence plus one new run, not a fresh
25-control replay.
They cover fresh proof and separate native subjects/receipts, ambiguous requests,
forged model markers, withdrawn approval/membership/permission, changed caller
candidates, task limits, unresolved actions, aborted preparation, failed activation,
guardian refusal and ordinary same-caller progression. A final-approval abort
control first failed and then passed after the actual activation correction.

For that original caller component, whole strict TypeScript passed again. All 758 serving outputs and their compiled
inputs were exact; the two changed tests are outside that emission graph, so no
runtime rebuild was needed. Three actual emitted, signed HTTP/media, real
clinical-host PostgreSQL cases pass: related then native-self booking, native
caller permission withdrawn after the second readback but before consent, and
native-self then related booking with fresh actor/patient proof. They retain native 180 requests per
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
preserved. Independent Spec review then exposed the same call closure after an
accepted event with failed activation. A new actual private-input control failed
before correction. Recovery now retires only the exact old private input and
requires a fresh explicit request and caller proof, preserving the call whether
the adapter observes idle before or after that request. Failure itself issues no
challenge or write; obsolete digits cannot verify the empty task. The direct-SQL sampler registers only this new exact test filename;
its isolation guards, pre-issue sampling and all privacy assertions remain.

## Current combined qualification, 31 October 2026

Review of the complete caller/guardian change found the caller-first related-task
activation branch lacked the same final cancellation and ownership fence as the
return-to-caller branch. A query abort during its last task-approval read first
reproduced an incorrect successful activation. The correction binds the pending
selection to its exact previous native owner and representative root, then checks
those identities, pending ownership, closure and cancellation after the last
awaited approval. Cancellation and pending abandonment each refuse activation,
issue no challenge or write and preserve the first receipt. An already accepted
workflow event retains the existing reserved-slot recovery rule.

Fresh combined qualification passes 111 source controls across eleven files:
27 caller/private-input controls and 84 guardian/file-source controls, with zero
skips. Whole strict TypeScript and an actual 760-output serving build pass. Only
`cliniko-call-flow.js` differs from the initial file-source build; the other 759
outputs remain exact. All seven signed PostgreSQL cases pass on that corrected
graph: both booking orders, native permission withdrawn before the second consent,
and the four file-source accepted/missing/withdrawn-authority booking outcomes.
Every-column scans, complete unfiltered backup and restore, unrelated retained
rows and owned database/container/volume/socket cleanup remain required and pass.
The original failed reproduction and prior source/runtime evidence are preserved.

This combines local engineering evidence. Actual parent integration, final review,
exact-head CI and resulting-main qualification remain delivery gates. The clinic,
carrier/acoustic and broader workflow limits below remain open.

## Remaining scope

The positive signed evidence covers one fixed, approved individual-service booking
composition in both subject orders. Caller routing also recognises the existing individual cancel, move
and enquiry operations, but their related-to-self compositions and broader
catalogue combinations are not established by these three cases. Classes, financial
work, registration, corrections and resends gain no representative authority.
Outbound task sequencing remains outside this inbound configuration.

Full-call evidence, actual clinic authority and record provisioning, staff duty,
access/retention, carrier/acoustic acceptance and deployment remain separate.
Local results do not complete the original execution plan. Independent review,
normal parent integration, exact-head CI and actual-main qualification are still
required before delivery.
