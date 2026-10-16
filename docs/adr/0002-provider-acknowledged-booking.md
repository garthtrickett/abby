---
status: proposed
---

# Use exact provider acknowledgements for external booking success

Revise only the individual and native class creation provisions of [ADR 0001](0001-standalone-cliniko-write-contract.md): finish authorization, provider-owned review and other preparation before final exact availability, send once, and preserve a validated native acknowledgement as booking success despite later observation or notification failure. This accepts the external provider's remaining races without a post-write veto; unacknowledged writes retain owned review and no automatic replay. Cancellation, rescheduling, registration/correction, resends, class movement/pass relinking and an owning diary's stronger transactional guarantees retain their operation-specific contracts.

The owner instructed execution of [the ordered plan](../../phase-2/EXECUTION_ORDER.md) on 16 October 2026. Delivery is staged under the [booking plan](../../phase-2/PROVIDER_ACKNOWLEDGED_BOOKING_PLAN.md): the first patch adds exact individual request/acknowledgement interval binding, including `ends_at`, while hosts still require their existing post-write inspection. This proposed replacement success policy becomes effective separately with the individual and class runtime steps; the receipt foundation alone does not activate it or approve a clinic, recovery workflow or deployment. Standalone phone-to-patient-ID-only persistence and Cliniko-owned pre-send review remain unchanged.
