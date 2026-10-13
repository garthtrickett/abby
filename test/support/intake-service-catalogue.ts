import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { intakeCallFlowFixture } from "./cliniko-call-flow.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import type { ServiceCatalogueApproval } from "../../src/standalone/owner-file-service-catalogue.ts";

/** First-time registration and independent approved initial-service native writers. */
export async function intakeServiceFixture() {
  const f = await intakeCallFlowFixture(); f.flow.dispose();
  const base = JSON.parse(await readFile(f.config.bookingApprovalPath, "utf8"));
  const members = [{ practitionerId: "22", name: "Demo Practitioner", gender: "male" as const },
    { practitionerId: "23", name: "Demo B", gender: "female" as const }, { practitionerId: "24", name: "Demo C", gender: "female" as const }];
  const services = [
    { serviceRef: "physiotherapy-initial", name: "Physiotherapy", appointmentTypeName: "Physiotherapy initial", appointmentTypeId: "34", durationMinutes: 60,
      visitKind: "initial" as const, searchDays: 7, followUpRule: null, practitioners: members },
    { serviceRef: "physiotherapy-short", name: "Physiotherapy", appointmentTypeName: "Physiotherapy short initial", appointmentTypeId: "35", durationMinutes: 45,
      visitKind: "initial" as const, searchDays: 7, followUpRule: null, practitioners: [members[0]!] },
    { serviceRef: "massage-initial", name: "Massage", appointmentTypeName: "Massage initial", appointmentTypeId: "36", durationMinutes: 45,
      visitKind: "initial" as const, searchDays: 7, followUpRule: null, practitioners: [members[0]!] },
  ];
  const path = join(f.folder, "initial-services.json");
  const { scope, policyVersion, businessId, credentialFingerprint, timeZone, approverRef, approvedAt, effectiveFrom, effectiveUntil } = base;
  let approval: ServiceCatalogueApproval = { scope, policyVersion, businessId, credentialFingerprint, timeZone, approverRef, approvedAt, effectiveFrom, effectiveUntil,
    approved: true, enabled: true, revision: "intake-services-1", locationName: "Demo North", eligibilityBasis: "callerAttestation", services };
  const replace = async (target: string, value: unknown) => { await writeFile(`${target}.next`, JSON.stringify(value), { mode: 0o600 }); await rename(`${target}.next`, target); };
  await replace(path, approval);
  const mappings = [];
  for (const service of services) {
    const practitioners = [];
    for (const member of service.practitioners) {
      const bookingApprovalPath = join(f.folder, `${service.serviceRef}-${member.practitionerId}.json`);
      await replace(bookingApprovalPath, { ...base, serviceRef: service.serviceRef, appointmentTypeId: service.appointmentTypeId,
        practitionerId: member.practitionerId, durationMinutes: service.durationMinutes, revision: `${service.serviceRef}-${member.practitionerId}` });
      practitioners.push({ practitionerId: member.practitionerId, bookingApprovalPath });
    }
    mappings.push({ serviceRef: service.serviceRef, practitioners });
  }
  const types = new Map(services.map(service => [service.appointmentTypeId, { name: service.appointmentTypeName, duration: service.durationMinutes }]));
  let failMember = ""; const original = f.flowConfig.fetchPort!;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value));
    if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true, archived_at: null, appointment_type_ids: [...types.keys()], time_zone_identifier: "Australia/Sydney" });
    if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: members.length, practitioners: members.map(member => ({ id: member.practitionerId })) });
    const practitioner = url.pathname.match(/^\/v1\/practitioners\/(22|23|24)$/);
    if (practitioner) return Response.json({ id: practitioner[1], display_name: members.find(member => member.practitionerId === practitioner[1])!.name, active: true, archived_at: null, show_in_online_bookings: true });
    if (/^\/v1\/practitioners\/(22|23|24)\/appointment_types$/.test(url.pathname)) return Response.json({ total_entries: types.size, appointment_types: [...types.keys()].map(id => ({ id })) });
    const type = url.pathname.match(/^\/v1\/appointment_types\/(34|35|36)$/);
    if (type) { const row = types.get(type[1]!)!; return Response.json({ id: type[1], name: row.name, duration_in_minutes: row.duration, show_in_online_bookings: true, archived_at: null }); }
    const available = url.pathname.match(/\/practitioners\/(23|24)\/.*\/available_times$/);
    if (available) return available[1] === failMember ? new Response(null, { status: 503 }) : Response.json({ total_entries: 1,
      available_times: [{ appointment_start: available[1] === "23" ? "2026-10-08T02:00:00.000Z" : "2026-10-08T01:00:00.000Z" }] });
    return original(value, init);
  };
  const flowConfig = { ...f.flowConfig, fetchPort, serviceCatalogue: { approvalPath: path, services: mappings } };
  const flow = resultValue(ClinikoCallFlow.create(flowConfig));
  return { ...f, flow, flowConfig, types, failMember: (id: string) => { failMember = id; },
    replaceServices: async (patch: Partial<ServiceCatalogueApproval>) => { approval = { ...approval, ...patch }; await replace(path, approval); },
    close: async () => { flow.dispose(); await f.close(); } };
}
