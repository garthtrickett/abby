import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import type { BookingCatalogueApproval } from "../../src/standalone/owner-file-booking-catalogue.ts";
import { bookingCallFlowFixture } from "./cliniko-call-flow.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { clinicDateAt } from "../../src/standalone/clinic-clock.ts";

/** Independently approved synthetic practitioners share one admitted location,
 * real proof/offer/guard/writer classes and the mandatory credential budget. */
export async function bookingCatalogueFixture() {
  const f = await bookingCallFlowFixture(); f.flow.dispose();
  const alternatePath = join(f.folder, "booking-alternative.json"), cataloguePath = join(f.folder, "booking-catalogue.json");
  const alternate = { ...f.approval, practitionerId: "23", revision: "booking-2" };
  const { scope, approverRef, approvedAt, effectiveFrom, effectiveUntil, policyVersion, credentialFingerprint, businessId, appointmentTypeId, timeZone } = f.approval;
  let approval: BookingCatalogueApproval = { scope, approverRef, approvedAt, effectiveFrom, effectiveUntil, policyVersion, credentialFingerprint, businessId,
    appointmentTypeId, timeZone, revision: "catalogue-1", approved: true, enabled: true, locationName: "Demo North", appointmentTypeName: "Physiotherapy", searchDays: 7,
    practitioners: [{ practitionerId: "22", name: "Demo A" }, { practitionerId: "23", name: "Demo B" }] };
  const replace = async (path: string, value: unknown) => { await writeFile(`${path}.new`, JSON.stringify(value), { mode: 0o600 }); await rename(`${path}.new`, path); };
  await replace(alternatePath, alternate); await replace(cataloguePath, approval);
  let times = ["2026-10-06T23:00:00.000Z", "2026-10-07T05:30:00.000Z", "2026-10-08T06:00:00.000Z"], failure = "";
  let onAlternateTimes: () => Promise<void> = async () => undefined;
  const original = f.flowConfig.fetchPort!;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value));
    if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 2, practitioners: [{ id: "22" }, { id: "23" }] });
    if (url.pathname === "/v1/practitioners/22") { const response = await original(value, init), data = await response.json();
      return Response.json({ ...data, display_name: "Demo A" }); }
    if (url.pathname === "/v1/practitioners/23") return Response.json({ id: "23", active: failure !== "inactive", archived_at: null,
      show_in_online_bookings: true, display_name: failure === "changedName" ? "Changed name" : "Demo B" });
    if (url.pathname === "/v1/practitioners/23/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }] });
    if (url.pathname.includes("/practitioners/23/") && url.pathname.endsWith("/available_times")) {
      await onAlternateTimes();
      if (failure === "server") return new Response(null, { status: 503 });
      const from = url.searchParams.get("from")!, to = url.searchParams.get("to")!;
      const selected = times.filter(time => { const date = clinicDateAt("Australia/Sydney", new Date(time)); return date >= from && date <= to; });
      return Response.json({ total_entries: selected.length, available_times: selected.map(appointment_start => ({ appointment_start })) });
    }
    return original(value, init);
  };
  const config = { ...f.flowConfig, fetchPort, catalogue: { approvalPath: cataloguePath, practitioners: [
    { practitionerId: "22", bookingApprovalPath: f.path }, { practitionerId: "23", bookingApprovalPath: alternatePath }] } };
  const flow = resultValue(ClinikoCallFlow.create(config));
  return { ...f, flow, flowConfig: config, reception: new TextReception(f.ledger, f.policies, flow),
    cataloguePath, alternatePath, setAlternateStarts: (value: string[]) => { times = value; }, setAlternateFailure: (value: string) => { failure = value; },
    setOnAlternateTimes: (run: () => Promise<void>) => { onAlternateTimes = run; },
    replaceCatalogue: async (patch: Partial<BookingCatalogueApproval>) => { approval = { ...approval, ...patch }; await replace(cataloguePath, approval); },
    revokeAlternate: () => replace(alternatePath, { ...alternate, approved: false }),
    close: async () => { flow.dispose(); await f.close(); } };
}
