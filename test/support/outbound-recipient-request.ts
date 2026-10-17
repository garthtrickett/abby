import { randomUUID } from "node:crypto";
import type { OutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
export function outboundRequestValue(): OutboundRecipientRequest {
  return { actionRef: randomUUID(), campaignRef: randomUUID(), effectRef: randomUUID(), approvalRef: randomUUID(),
    scope: { tenantId: "outbound-fixture", clinicId: "fixture-clinic", locationId: "fixture-location" },
    businessId: "11", credentialFingerprint: "a".repeat(64), patientId: "21", purpose: "followUp",
    recipient: { kind: "voice", number: "+12025550123" }, policy: { version: "outbound-1", digest: "b".repeat(64) },
    schedule: { notBefore: "2026-11-02T00:00:00.000Z", expiresAt: "2026-11-03T00:00:00.000Z", timeZone: "Australia/Sydney",
      weekdays: [1, 2, 3, 4, 5], opensAt: "09:00", closesAt: "17:00" }, requestedAt: "2026-11-01T10:00:00.000Z" };
}
