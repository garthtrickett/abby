---
status: accepted
---

# Separate standalone Cliniko and owning-diary write contracts

The [proposed booking-only revision](0002-provider-acknowledged-booking.md) is being delivered in stages. Exact individual interval acknowledgement checks are the first foundation; the existing host success gates below remain until the corresponding runtime changes are delivered.

The product owner selected best-effort standalone Cliniko writes with exact validation, one possible send, post-write inspection and approved Cliniko-owned review, while retaining atomic exclusion, conditional targets and exact receipts for an embedded host that owns its diary. This accepts external-writer races explicitly rather than attributing atomic guarantees to reads; Abby's phone-to-patient-ID-only storage rule remains fixed. Decision accepted 2026-10-04 as D-16; D-15 now applies the mode-specific activation contract. Current unavailable modes remain in force until the remaining clinic and implementation gates pass. The [reviewable contract and nine-step completion evidence](../../phase-2/STANDALONE_CLINIKO_WRITE_PROPOSAL.md) explain the alternatives, request-before-mutation recovery candidate and separate pre-patient intake limitation.
