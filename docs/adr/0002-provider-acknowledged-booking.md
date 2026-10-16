---
status: accepted
---

# Use exact provider acknowledgements for external booking success

Revise only the individual and native class creation provisions of [ADR 0001](0001-standalone-cliniko-write-contract.md): finish authorization, provider-owned review and other preparation before final exact availability, send once, and preserve a validated native acknowledgement as booking success despite later observation or notification failure. This accepts the external provider's remaining races without a post-write veto; unacknowledged writes retain owned review and no automatic replay. Cancellation, rescheduling, registration/correction, resends, class movement/pass relinking and an owning diary's stronger transactional guarantees retain their operation-specific contracts.

The owner instructed execution of [the ordered plan](../../phase-2/EXECUTION_ORDER.md) on 16 October 2026. Delivery is staged under the [booking plan](../../phase-2/PROVIDER_ACKNOWLEDGED_BOOKING_PLAN.md): the receipt foundation binds the full individual interval, and the next individual runtime patch completes preparation before online/roster availability and establishes success at the validated acknowledgement. A narrow in-process acknowledgement notification preserves that result through host, review and worker cancellation; ordinary result/action/lease validation still applies. No post-write GET, conflict veto, compensation or automatic review closure belongs to individual creation's success path.

Native class creation remains on its existing inspected contract until its separate runtime step. This scoped decision approves neither a clinic, recovery workflow nor deployment. Standalone phone-to-patient-ID-only persistence and Cliniko-owned pre-send review remain unchanged. Source delivery, exact-head CI/independent review and activation acceptance are separate evidence; see [the progress ledger](../../phase-2/EXECUTION_PROGRESS.md).
