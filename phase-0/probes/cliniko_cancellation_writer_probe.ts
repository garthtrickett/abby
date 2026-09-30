import { readFileSync } from "node:fs";
import { ClinikoCancellationWriter } from "../../src/cliniko/cancellation-write.ts";

// The owning Python probe creates and later independently reconciles this one synthetic appointment.
// Stdin carries the credential and target; stdout contains no credential, ID or appointment detail.
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  const scope = { tenantId: "demo-probe", clinicId: "demo-probe", locationId: "demo-probe" };
  const adapter = ClinikoCancellationWriter.create({ scope,
    apiKey: String(input.apiKey), contactEmail: String(input.contactEmail),
    businessId: String(input.businessId) });
  if (!adapter.ok) throw new Error("invalid configuration");
  const request = { scope, patientId: String(input.patientId), appointmentId: String(input.appointmentId),
    practitionerId: String(input.practitionerId), appointmentTypeId: String(input.appointmentTypeId),
    startsAt: String(input.startsAt), endsAt: String(input.endsAt), cancellationReason: 50 as const };
  const written = await adapter.value.cancelOnce(request);
  const observed = await adapter.value.observe(request);
  const repeated = await adapter.value.cancelOnce(request);
  const result = { ok: written.ok && written.value.kind === "cancelled" &&
    observed.ok && observed.value.kind === "cancelled" &&
    !repeated.ok && repeated.error.kind === "invalidQuery",
  writeKind: written.ok ? written.value.kind : "error",
  observationKind: observed.ok ? observed.value.kind : "error",
  repeatedAttemptRejected: !repeated.ok && repeated.error.kind === "invalidQuery" };
  process.stdout.write(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch {
  process.stdout.write(JSON.stringify({ ok: false, writeKind: "error", observationKind: "error",
    repeatedAttemptRejected: false }));
  process.exitCode = 1;
}
