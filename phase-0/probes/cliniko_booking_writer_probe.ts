import { readFileSync } from "node:fs";
import { ClinikoBookingWriter } from "../../src/cliniko/booking-write.ts";

// The controlled Python probe owns the synthetic patient and cleanup. Neither
// stdout nor stderr may contain the credential or a provider patient record.
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  const scope = { tenantId: "demo-probe", clinicId: "demo-probe", locationId: "demo-probe" };
  const created = ClinikoBookingWriter.create({ scope, apiKey: String(input.apiKey),
    contactEmail: String(input.contactEmail), businessId: String(input.businessId),
    practitionerId: String(input.practitionerId), appointmentTypeId: String(input.appointmentTypeId) });
  if (!created.ok) {
    process.stdout.write(JSON.stringify({ ok: false, kind: created.error.kind }));
    process.exitCode = 1;
  } else {
    const request = { scope, patientId: String(input.patientId), startsAt: String(input.startsAt),
      marker: String(input.markerToken) };
    const sent = await created.value.writeOnce(request);
    const observed = await created.value.observe(request);
    const writeKind = sent.ok ? sent.value.kind : sent.error.kind;
    const observationKind = observed.ok ? observed.value.kind : observed.error.kind;
    const exact = sent.ok && sent.value.kind === "accepted" && observed.ok &&
      observed.value.kind === "one" && observed.value.active &&
      sent.value.appointmentRef === observed.value.appointmentRef;
    process.stdout.write(JSON.stringify({ ok: exact, writeKind, observationKind,
      exact: exact === true }));
    if (!exact) process.exitCode = 1;
  }
} catch {
  process.stdout.write(JSON.stringify({ ok: false, kind: "probeFailure" }));
  process.exitCode = 1;
}
