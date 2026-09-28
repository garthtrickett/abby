import { readFileSync } from "node:fs";
import { ClinikoAppointmentReader } from "../../src/cliniko/appointments.ts";
import { ok } from "../../src/core/model.ts";
import type { PatientProofHost } from "../../src/core/host.ts";

// Called only by the controlled synthetic write probe. Input contains a key and
// synthetic IDs; stdout contains no credential, patient ID, or appointment ID.
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  const scope = { tenantId: "demo-probe", clinicId: "demo-probe", locationId: "demo-probe" };
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 10 * 60_000).toISOString();
  const proof: PatientProofHost = {
    verifyPatient: async () => ok({ scope, patientRef: String(input.patientId), verificationRef: "synthetic-probe", expiresAt }),
  };
  const created = ClinikoAppointmentReader.create({ scope, apiKey: String(input.apiKey),
    contactEmail: String(input.contactEmail), businessId: String(input.businessId) }, proof);
  if (!created.ok) {
    process.stdout.write(JSON.stringify({ ok: false, kind: created.error.kind }));
    process.exitCode = 1;
  } else {
    const result = await created.value.list(scope, "synthetic-probe", now,
      new Date(Date.parse(now) + 7 * 86_400_000).toISOString(), now);
    if (!result.ok) {
      process.stdout.write(JSON.stringify({ ok: false, kind: result.error.kind }));
      process.exitCode = 1;
    } else {
      process.stdout.write(JSON.stringify({ ok: true, count: result.value.appointments.length,
        exact: result.value.appointments.length === 1 &&
          result.value.appointments[0]?.appointmentRef === String(input.appointmentId),
        timeZone: result.value.timeZone }));
    }
  }
} catch {
  process.stdout.write(JSON.stringify({ ok: false, kind: "probeFailure" }));
  process.exitCode = 1;
}
