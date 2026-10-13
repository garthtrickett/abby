import { readFile, writeFile, rename } from "node:fs/promises";
import { serviceBookingFixture } from "./service-booking-catalogue.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";

/** Two independently approved locations with distinct native Cliniko businesses. */
export async function locationServiceFixture() {
  const north = await serviceBookingFixture(); north.flow.dispose();
  const south = await serviceBookingFixture({ scope: { ...north.scope, locationId: "south" } }); south.flow.dispose();
  const initial = south.serviceApproval.services.find(service => service.serviceRef === "physiotherapy-initial")!;
  await north.replaceServices({ locationName: "North" });
  await south.replaceServices({ locationName: "South", businessId: "12", services: [initial] });
  for (const row of south.flowConfig.serviceCatalogue.services) for (const member of row.practitioners) {
    const path = member.bookingApprovalPath;
    const approval = JSON.parse(await readFile(path, "utf8"));
    await writeFile(`${path}.next`, JSON.stringify({ ...approval, businessId: "12" }), { mode: 0o600 }); await rename(`${path}.next`, path);
  }
  const original = south.flowConfig.fetchPort!;
  const port: typeof fetch = async (value, init) => {
    const url = new URL(String(value)); url.pathname = url.pathname.replace("/businesses/12", "/businesses/11");
    const response = await original(url.toString(), init);
    if (!response.headers.get("content-type")?.includes("application/json")) return response;
    const row = await response.json();
    if (url.pathname === "/v1/businesses/11") row.id = "12";
    return Response.json(JSON.parse(JSON.stringify(row).replaceAll("/businesses/11", "/businesses/12")), { status: response.status });
  };
  const southConfig = { ...south.flowConfig, fetchPort: port, cliniko: { ...south.flowConfig.cliniko, businessId: "12" },
    serviceCatalogue: { ...south.flowConfig.serviceCatalogue, services: south.flowConfig.serviceCatalogue.services.filter(service => service.serviceRef === initial.serviceRef) } };
  const sources = [north, south].map((f, index) => ({ path: f.servicePath, scope: f.scope, directory: f.directory,
    policyVersion: f.serviceApproval.policyVersion, businessId: index ? "12" : "11", credentialFingerprint: f.serviceApproval.credentialFingerprint,
    timeZone: f.serviceApproval.timeZone, ...(f.flowConfig.clock ? { clock: f.flowConfig.clock } : {}) }));
  return { north, south, southConfig, sources,
    routingHost: (accountRef: string) => new ReferenceNumberRoutingHost([
      { accountRef, dialedNumber: north.inbound.dialedNumber, ...north.scope, spokenName: "North", routeVersion: "locations-1" },
      { accountRef, dialedNumber: north.inbound.dialedNumber, ...south.scope, spokenName: "South", routeVersion: "locations-1" },
    ]), close: async () => { await south.close(); await north.close(); } };
}
