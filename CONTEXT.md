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

## Practitioner change

A clinic-approved change of the practitioner assigned to an existing appointment.
The patient, appointment identity, location, service and duration are retained.
The caller confirms the destination practitioner under current authority for
that appointment.

## Practitioner directory

Clinic-approved practitioner options for an existing appointment that preserve
its location, service and duration. A directory choice identifies whose
availability to check; only a confirmed practitioner change alters the appointment.

## Patient details correction

An authorized change to approved personal or contact details on an existing
patient record. A correction retains the record's identity and appointments;
a confirmation resend has its own authorization and outcome.

## Best-effort write

A confirmed request is checked and attempted once under the approved external provider contract. Completion requires the evidence declared for that operation. Competing edits, overlaps or duplicates may still occur; unknown outcomes require owned review rather than replay or a completion claim. It does not promise commit protection.

## Provider acknowledged booking

An external booking whose exact authorized appointment or class attendance creation is established by the provider's successful acknowledgement. Later observation or notification failure cannot erase that established result; a missing or ambiguous acknowledgement remains uncertain. Creation alone establishes neither payment nor an unlinked class attendance required for a separate move.

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

## Location service discovery

A caller asks which services are listed at the locations sharing a clinic number before choosing one location. Public service information grants neither patient disclosure nor appointment availability, verification or booking authority.

## Registration service choice

An explicitly new patient chooses an approved initial service and duration before registration. This choice permits neither saving patient details nor booking: each requires its own permission and confirmation. A pre-registration correction discards the previous private draft; a completed or uncertain registration is never repeated to change the service.


## Operational alert

A notice about clinic infrastructure or aggregate queue health that requires operational attention. It is separate from a patient-specific review request.
_Avoid_: Patient message, saved patient request.

## Operator acknowledgment

An authenticated, currently authorized operator explicitly accepts responsibility for an operational alert for an approved period. It establishes neither the outcome of a patient request nor completion of the underlying recovery work.
_Avoid_: Transport acceptance, clinical completion.

## Responsibility escalation

An unacknowledged alert or expired responsibility period becomes the responsibility of the clinic's currently approved backup. Assignment alone does not establish that the backup has read or acknowledged it.
_Avoid_: Delivered callback, completed recovery.
