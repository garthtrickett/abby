import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceCatalogueApproval } from "../../src/standalone/owner-file-service-catalogue.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { clinicDateAt } from "../../src/standalone/clinic-clock.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { serviceBookingFixture } from "./service-booking-catalogue.ts";

/** Three independently approved native writers. Provider metadata deliberately
 * contains no gender: the public preference uses only the clinic approval. */
export async function servicePractitionerFixture() {
  const f = await serviceBookingFixture(); f.flow.dispose();
  const members = [{ practitionerId: "22", name: "Demo Practitioner", gender: "male" as const },
    { practitionerId: "23", name: "Demo B", gender: "female" as const }, { practitionerId: "24", name: "Demo C", gender: "female" as const }];
  const paths = [f.initialPath, join(f.folder, "initial-alternate-b.json"), join(f.folder, "initial-alternate-c.json")];
  const replace = async (path: string, value: unknown) => { await writeFile(`${path}.next`, JSON.stringify(value), { mode: 0o600 }); await rename(`${path}.next`, path); };
  let approval: ServiceCatalogueApproval = { ...f.serviceApproval, services: f.serviceApproval.services.map(service => service.appointmentTypeId === "34" ? { ...service, practitioners: members } : service) };
  await f.replaceServices(approval);
  for (const [index, member] of members.entries()) if (index > 0) await replace(paths[index]!, { ...f.approval,
    practitionerId: member.practitionerId, appointmentTypeId: "34", serviceRef: "physiotherapy-initial", durationMinutes: 60, revision: `initial-${member.practitionerId}` });
  const starts = new Map<string, string[]>([["23", ["2026-10-08T02:00:00.000Z"]], ["24", ["2026-10-08T01:00:00.000Z"]]]);
  let failure = "", onTimes: () => Promise<void> = async () => undefined;
  const traffic: string[] = [], original = f.flowConfig.fetchPort!;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)); traffic.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 3, practitioners: members.map(({ practitionerId }) => ({ id: practitionerId })) });
    const practitioner = url.pathname.match(/^\/v1\/practitioners\/(23|24)$/);
    if (practitioner) return Response.json({ id: practitioner[1], active: true, archived_at: null, show_in_online_bookings: true,
      display_name: members.find(member => member.practitionerId === practitioner[1])!.name });
    if (/^\/v1\/practitioners\/(23|24)\/appointment_types$/.test(url.pathname)) return Response.json({ total_entries: 1, appointment_types: [{ id: "34" }] });
    const available = url.pathname.match(/\/practitioners\/(23|24)\/.*\/available_times$/);
    if (available) {
      await onTimes();
      if (failure === available[1]) return new Response(null, { status: 503 });
      const times = starts.get(available[1]!)!.filter(start => { const day = clinicDateAt("Australia/Sydney", new Date(start));
        return day >= url.searchParams.get("from")! && day <= url.searchParams.get("to")!; });
      return Response.json({ total_entries: times.length, available_times: times.map(appointment_start => ({ appointment_start })) });
    }
    return original(value, init);
  };
  const config = { ...f.flowConfig, fetchPort, serviceCatalogue: { ...f.flowConfig.serviceCatalogue,
    services: f.flowConfig.serviceCatalogue.services.map(service => service.serviceRef === "physiotherapy-initial"
      ? { ...service, practitioners: members.map((member, index) => ({ practitionerId: member.practitionerId, bookingApprovalPath: paths[index]! })) } : service) } };
  const flow = resultValue(ClinikoCallFlow.create(config));
  return { ...f, flow, flowConfig: config, serviceApproval: approval, traffic, members, paths,
    setStarts: (id: string, times: string[]) => starts.set(id, times), setFailure: (id: string) => { failure = id; },
    setOnPreferenceTimes: (work: () => Promise<void>) => { onTimes = work; },
    replaceServices: async (patch: Partial<ServiceCatalogueApproval>) => { approval = { ...approval, ...patch }; await f.replaceServices(approval); },
    revokeMember: (index: number) => replace(paths[index]!, { ...f.approval, approved: false }),
    close: async () => { flow.dispose(); await f.close(); } };
}
