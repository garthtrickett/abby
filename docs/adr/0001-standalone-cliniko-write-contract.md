---
status: accepted
---

# Separate standalone Cliniko and owning-diary write contracts

The [booking-only revision](0002-provider-acknowledged-booking.md) amends individual creation to use exact provider acknowledgement after final availability. Class creation remains staged separately. The paragraph below records the original D-16 decision; its post-write inspection provisions continue for other operations and the earlier embedded test host.

The product owner selected best-effort standalone Cliniko writes with exact validation, one possible send, post-write inspection and approved Cliniko-owned review, while retaining atomic exclusion, conditional targets and exact receipts for an embedded host that owns its diary. This accepts external-writer races explicitly rather than attributing atomic guarantees to reads; Abby's phone-to-patient-ID-only storage rule remains fixed. Decision accepted 2026-10-04 as D-16; D-15 now applies the mode-specific activation contract. Current unavailable modes remain in force until the remaining clinic and implementation gates pass. The [reviewable contract and nine-step completion evidence](../../phase-2/STANDALONE_CLINIKO_WRITE_PROPOSAL.md) explain the alternatives, request-before-mutation recovery candidate and separate pre-patient intake limitation.
