import { readFileSync } from "node:fs";
import { ClinikoBookingWriter } from "../../src/cliniko/booking-write.ts";

// The controlled Python probe owns the synthetic patient and cleanup. Neither
// stdout nor stderr may contain the credential or a provider patient record.
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  const scope = { tenantId: "demo-probe", clinicId: "demo-probe", locationId: "demo-probe" };
  const dropPostResponse = process.env.ABBY_LIVE_CLINIKO_EVAL === "1" &&
    process.env.ABBY_PROBE_LOSE_POST_RESPONSE === "1";
  let postResponseDiscarded = false;
  const fetchPort: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (dropPostResponse && init?.method === "POST") {
      postResponseDiscarded = true;
      await response.body?.cancel();
      throw new Error("synthetic response loss after provider POST");
    }
    return response;
  };
  const created = ClinikoBookingWriter.create({ scope, apiKey: String(input.apiKey),
    contactEmail: String(input.contactEmail), businessId: String(input.businessId),
    practitionerId: String(input.practitionerId), appointmentTypeId: String(input.appointmentTypeId) }, fetchPort);
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
    const matchingWrite = sent.ok && (
      (sent.value.kind === "accepted" && observed.ok && observed.value.kind === "one" &&
        sent.value.appointmentRef === observed.value.appointmentRef) ||
      (postResponseDiscarded && sent.value.kind === "uncertain")
    );
    const exact = matchingWrite && observed.ok && observed.value.kind === "one" && observed.value.active;
    process.stdout.write(JSON.stringify({ ok: exact, writeKind, observationKind,
      exact: exact === true, injectedPostResponseLoss: postResponseDiscarded }));
    if (!exact) process.exitCode = 1;
  }
} catch {
  process.stdout.write(JSON.stringify({ ok: false, kind: "probeFailure" }));
  process.exitCode = 1;
}
