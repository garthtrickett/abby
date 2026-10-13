import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import type { ServiceCatalogueApproval } from "../../src/standalone/owner-file-service-catalogue.ts";
import { bookingCallFlowFixture } from "./cliniko-call-flow.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

/** Approved synthetic public variants; the same actual proof, offer, policy,
 * review and writer classes are exercised for every selected provider type. */
export async function serviceBookingFixture() {
  const f = await bookingCallFlowFixture(); f.flow.dispose();
  const path = join(f.folder, "service-catalogue.json"), initialPath = join(f.folder, "initial-booking.json"), massagePath = join(f.folder, "massage-booking.json"), shortInitialPath = join(f.folder, "short-initial-booking.json");
  const { scope, policyVersion, businessId, credentialFingerprint, timeZone, approverRef, approvedAt, effectiveFrom, effectiveUntil } = f.approval;
  const followUp = { serviceRef: "physiotherapy", name: "Physiotherapy", appointmentTypeName: "Physiotherapy follow-up", appointmentTypeId: "33", durationMinutes: 30,
    visitKind: "followUp" as const, searchDays: 7, followUpRule: { returningRequired: true, newProblemRequiresInitial: true, maxMonthsSinceLastVisit: 3 },
    practitioners: [{ practitionerId: "22", name: "Demo Practitioner" }] };
  const initial = { ...followUp, serviceRef: "physiotherapy-initial", appointmentTypeId: "34", appointmentTypeName: "Physiotherapy initial", durationMinutes: 60,
    visitKind: "initial" as const, followUpRule: null };
  const massage = { ...initial, serviceRef: "massage-initial", name: "Massage", appointmentTypeId: "35", appointmentTypeName: "Massage initial", durationMinutes: 45 };
  const shortInitial = { ...initial, serviceRef: "physiotherapy-short-initial", appointmentTypeId: "36", appointmentTypeName: "Physiotherapy short initial", durationMinutes: 45 };
  let approval: ServiceCatalogueApproval = { scope, policyVersion, businessId, credentialFingerprint, timeZone, approverRef, approvedAt, effectiveFrom, effectiveUntil,
    approved: true, enabled: true, revision: "services-1", locationName: "Demo North", eligibilityBasis: "callerAttestation", services: [followUp, initial, massage, shortInitial] };
  const replace = async (target: string, value: unknown) => { await writeFile(`${target}.next`, JSON.stringify(value), { mode: 0o600 }); await rename(`${target}.next`, target); };
  await replace(path, approval);
  await replace(initialPath, { ...f.approval, appointmentTypeId: "34", serviceRef: initial.serviceRef, durationMinutes: 60, revision: "initial-1" });
  await replace(massagePath, { ...f.approval, appointmentTypeId: "35", serviceRef: massage.serviceRef, durationMinutes: 45, revision: "massage-1" });
  await replace(shortInitialPath, { ...f.approval, appointmentTypeId: "36", serviceRef: shortInitial.serviceRef, durationMinutes: 45, revision: "short-initial-1" });
  const providerTypes = new Map<string, { name: string; duration: number; online?: boolean; archived?: boolean }>(approval.services.map(service => [service.appointmentTypeId, { name: service.appointmentTypeName, duration: service.durationMinutes }]));
  const original = f.flowConfig.fetchPort!;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value));
    if (url.pathname === "/v1/businesses/11") { const row = await (await original(value, init)).json(); return Response.json({ ...row, appointment_type_ids: ["33", "34", "35", "36"] }); }
    if (url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 4, appointment_types: [{ id: "33" }, { id: "34" }, { id: "35" }, { id: "36" }] });
    if (url.pathname.startsWith("/v1/appointment_types/")) {
      const id = url.pathname.split("/").at(-1)!, row = providerTypes.get(id); if (!row) return new Response(null, { status: 404 });
      return Response.json({ id, name: row.name, duration_in_minutes: row.duration, show_in_online_bookings: row.online !== false, archived_at: row.archived ? f.approval.approvedAt : null });
    }
    return original(value, init);
  };
  const config = { ...f.flowConfig, fetchPort, serviceCatalogue: { approvalPath: path, services: [
    { serviceRef: followUp.serviceRef, practitioners: [{ practitionerId: "22", bookingApprovalPath: f.path }] },
    { serviceRef: initial.serviceRef, practitioners: [{ practitionerId: "22", bookingApprovalPath: initialPath }] },
    { serviceRef: massage.serviceRef, practitioners: [{ practitionerId: "22", bookingApprovalPath: massagePath }] },
    { serviceRef: shortInitial.serviceRef, practitioners: [{ practitionerId: "22", bookingApprovalPath: shortInitialPath }] },
  ] } };
  const flow = resultValue(ClinikoCallFlow.create(config));
  return { ...f, flow, flowConfig: config, reception: new TextReception(f.ledger, f.policies, flow), serviceApproval: approval, servicePath: path, initialPath, massagePath,
    providerTypes, replaceServices: async (patch: Partial<ServiceCatalogueApproval>) => { approval = { ...approval, ...patch }; await replace(path, approval); },
    close: async () => { flow.dispose(); await f.close(); } };
}
