import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoAppointmentReader } from "../../src/cliniko/appointments.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const began = "2026-09-28T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(began) + seconds * 1000).toISOString();

for (const scenario of ["laterObservation", "futureSnapshot", "expiredProof", "sameClock"] as const) {
  test(`appointment read uses independent completion time rather than turn/provider time: ${scenario}`, async () => {
    const scope = { tenantId: "read-clock", clinicId: "clinic", locationId: "main" };
    const callId = randomUUID(), verificationRef = "synthetic-read-proof";
    let current = at(3), requests = 0;
    const host = new ReferenceClinicHost([{ scope, patientRef: "22", verificationRef,
      expiresAt: at(86_400) }], []);
    const port: typeof fetch = async input => {
      requests++;
      const url = new URL(String(input));
      if (scenario !== "sameClock") current = at(5);
      if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", time_zone_identifier: "Australia/Sydney" });
      assert.equal(url.pathname, "/v1/individual_appointments");
      return Response.json({ total_entries: 1, individual_appointments: [{
        id: "33", starts_at: "2026-09-30T11:00:00Z", ends_at: "2026-09-30T11:30:00Z",
        patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/22" } },
        business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } },
        cancelled_at: null, archived_at: null, deleted_at: null,
      }] });
    };
    const reader = resultValue(ClinikoAppointmentReader.create({ scope, apiKey: "synthetic-key-au5",
      contactEmail: "dev@example.test", businessId: "11" }, host, port, () => current));
    const appointments = { list: async (...args: Parameters<typeof reader.list>) => {
      const result = await reader.list(...args);
      if (!result.ok) return result;
      // Independently hostile read-surface fields must not supply the clock.
      // The native reader keeps its own original120s proof-headroom guard.
      return { ...result, value: { ...result.value,
        ...(scenario === "futureSnapshot" ? { observedAt: at(6) } : {}),
        ...(scenario === "expiredProof" ? { proofExpiresAt: at(4) } : {}) } };
    } };
    const ledger = new MemoryLedger(), policy = withApprovedSyntheticVoice(new MemoryPolicyStore());
    const reception = new TextReception(ledger, policy, host, undefined, appointments, undefined, undefined, () => current);
    try {
      resultValue(await reception.startCall(callId, scope, began));
      const turnAt = scenario === "laterObservation" ? at(2) : scenario === "futureSnapshot" ? at(7) : at(3);
      const state = resultValue(await reception.checkAppointments(scope,
        { callId, turnId: randomUUID(), at: turnAt, text: "Read my appointments", quality: "clear" },
        verificationRef, at(3), "2026-10-05T10:00:00.000Z", turnAt));
      assert.equal(requests, 2);
      const shown = scenario === "laterObservation" || scenario === "sameClock";
      assert.equal(state.appointmentReads.at(-1)?.status, shown ? "shown" : "failed");
      assert.equal(Object.keys(state.staffItems).length, shown ? 0 : 1);
      assert.equal(state.callerMessages.some(message => message.includes("Wednesday 30 September")), shown);
      assert.equal(JSON.stringify(state).includes(verificationRef), false);
    } finally { ledger.dispose(); }
  });
}
