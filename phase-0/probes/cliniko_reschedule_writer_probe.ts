import { readFileSync } from "node:fs";
import { ClinikoRescheduleWriter } from "../../src/cliniko/reschedule-write.ts";

// The owning Python probe creates, independently observes, then cancels the synthetic appointment.
// Stdin carries the credential and exact target; stdout contains no credential or appointment detail.
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  const scope = { tenantId: "demo-probe", clinicId: "demo-probe", locationId: "demo-probe" };
  const dropPatchResponse = process.env.ABBY_LIVE_CLINIKO_EVAL === "1" &&
    process.env.ABBY_PROBE_LOSE_MOVE_RESPONSE === "1";
  let patchResponseDiscarded = false;
  const fetchPort: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (dropPatchResponse && init?.method === "PATCH") {
      patchResponseDiscarded = true;
      await response.body?.cancel();
      throw new Error("synthetic response loss after provider move");
    }
    return response;
  };
  const adapter = ClinikoRescheduleWriter.create({ scope, apiKey: String(input.apiKey),
    contactEmail: String(input.contactEmail), businessId: String(input.businessId) }, fetchPort);
  if (!adapter.ok) throw new Error("invalid configuration");
  const request = { scope, patientId: String(input.patientId), appointmentId: String(input.appointmentId),
    practitionerId: String(input.practitionerId), appointmentTypeId: String(input.appointmentTypeId),
    startsAt: String(input.startsAt), endsAt: String(input.endsAt),
    newStartsAt: String(input.newStartsAt), newEndsAt: String(input.newEndsAt) };
  const written = await adapter.value.rescheduleOnce(request);
  const observed = await adapter.value.observeReschedule(request);
  const repeated = await adapter.value.rescheduleOnce(request);
  const result = { ok: written.ok &&
    (patchResponseDiscarded ? written.value.kind === "uncertain" : written.value.kind === "moved") &&
    observed.ok && observed.value.kind === "new" &&
    !repeated.ok && repeated.error.kind === "invalidQuery",
  writeKind: written.ok ? written.value.kind : "error",
  observationKind: observed.ok ? observed.value.kind : "error",
  repeatedAttemptRejected: !repeated.ok && repeated.error.kind === "invalidQuery",
  injectedMoveResponseLoss: patchResponseDiscarded };
  process.stdout.write(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch {
  process.stdout.write(JSON.stringify({ ok: false, writeKind: "error", observationKind: "error",
    repeatedAttemptRejected: false, injectedMoveResponseLoss: false }));
  process.exitCode = 1;
}
