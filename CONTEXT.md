# Abby domain terms

## Write activation

A clinic and location may offer a patient action only when the owning system supports that action, the clinic approves its use, and the authority, result and recovery evidence required by its declared write contract has been established. Approval of one action does not approve another.

## Commit protection

The owning system prevents a mutation from acting on an outdated authorized target, an unavailable interval or a duplicate patient/request when the mutation occurs. Protection must apply to every actor that can change the relevant record or interval.

## Caller authority

A clinic-approved verification and consent process permits the current caller to perform one operation for the intended patient. A matching phone number is a clue, not caller authority.

## Outcome uncertainty

A request may have changed the owning system, but its exact outcome has not been established. Uncertainty permits truthful status and review; it does not permit another mutation attempt or a completion claim.

## Request-only capability

A patient action is saved for staff through an approved, owned and recoverable workflow. It does not complete the appointment action. A generic alert or instruction to contact the clinic is not a saved patient request.

Other established terms are defined in [PRD section 5](PRD.md#5-canonical-terms).

## Best-effort write

A confirmed request is checked and attempted once, then inspected under the approved external provider contract. Competing edits, overlaps or duplicates may still occur; unknown outcomes require owned review rather than replay or a completion claim. It does not promise commit protection.

## Review request

A durable request for a staff owner to examine an intended action and its unresolved outcome. Its presence proves neither that the action was sent nor that it completed, and does not authorize an automatic mutation.

## Email verification

The caller demonstrates control of the patient’s currently registered email channel using a short-lived code. It grants only the patient action permitted by the clinic’s current policy; it does not establish representative authority or turn a phone match into proof.

## Caller-mediated intake recovery

Before first-time registration, the caller separately acknowledges that a failure can leave a patient record without an appointment or saved staff request. Unknown creation is not retried automatically; the caller contacts the clinic to resolve it. This does not promise recoverable staff work or grant appointment authority.

## Newly registered patient

A patient whose registration was proven during the current call. Registration success is separate from appointment success. Booking for this patient requires independently approved permission and a separate caller confirmation; a rejected or uncertain booking leaves the patient record intact.

## Booking service

A clinic-approved combination of service, initial or follow-up visit, and duration offered at a particular location. Choosing it grants neither patient permission nor a reserved appointment time.

## Caller attestation

The caller's explicit answers about previous attendance and a new problem, evaluated under the clinic's approved return-visit rules. They do not establish a Cliniko-verified treatment history.

## Practitioner preference

The caller's choice of any eligible practitioner, a named practitioner, or a clinic-declared gender within the chosen service. It narrows eligibility without establishing clinical suitability or permission to use a different practitioner for an existing appointment.

## Previous practitioner

The practitioner named by the latest eligible past appointment record in the clinic's approved history period. This identifies a recorded booking relationship without establishing attendance, treatment suitability or permission to book with that practitioner.
