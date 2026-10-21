import { randomUUID } from "node:crypto";
import { administrativeMemoActionRef } from "../../src/cliniko/administrative-memo.ts";
import type { AdministrativeMemoOutcome, UnsignedAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";

/** Synthetic contract input only, not an actual clinical receipt producer. */
export function administrativeMemoInput(kind: AdministrativeMemoOutcome["kind"] = "bookingConfirmed"): UnsignedAdministrativeMemo {
  const sourceActionRef = randomUUID();
  return { actionRef: administrativeMemoActionRef(sourceActionRef)!, sourceActionRef,
    scope: { tenantId: "memo-tenant", clinicId: "clinic", locationId: "main" }, businessId: "1",
    credentialFingerprint: clinikoCredentialFingerprint("synthetic-memo-au5"), patientId: "321", authorRef: "approved-memo-producer",
    policy: { version: "admin-actions-v1", digest: "a".repeat(64) }, direction: "inbound",
    outcome: { kind, appointmentRef: kind === "classBookingConfirmed" || kind === "classCancellationObserved" ? "cliniko:booking:900" : "cliniko:appointment:900", startsAt: "2026-11-05T01:00:00.000Z", endsAt: "2026-11-05T01:30:00.000Z",
      ...(kind === "classBookingConfirmed" || kind === "classCancellationObserved" ? { attendeeRef: "cliniko:attendee:901" } : {}),
      ...(kind === "cancellationObserved" || kind === "reschedulingObserved" || kind === "classCancellationObserved" ? { verification: { basis: "acknowledgedAndObservedBestEffort", observedAt: "2026-11-02T00:00:00.000Z" } } : {}),
      ...(kind === "reschedulingObserved" ? { practitionerRef: "cliniko:practitioner:22",
        previous: { startsAt: "2026-11-04T01:00:00.000Z", endsAt: "2026-11-04T01:30:00.000Z", practitionerRef: "cliniko:practitioner:22" } } : {}) } as AdministrativeMemoOutcome,
    occurredAt: "2026-11-02T00:00:00.000Z", recordedAt: "2026-11-02T00:00:00.000Z" };
}
