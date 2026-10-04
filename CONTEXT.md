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
