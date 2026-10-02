import { ok } from "../../src/core/model.ts";
import type { StaffedDestinationHost, StaffedDestinationRegistry } from "../../src/core/staffed-destination.ts";

/** Public reference-host display names; resolve still independently checks every selected route. */
export function staffedDestinationRegistry(resolve: StaffedDestinationHost): StaffedDestinationRegistry {
  return { resolve, list: async scope => ok({ scope: structuredClone(scope), hostVersion: "host-route-v1",
    options: [{ destinationRef: "host/desk-a", label: "Front desk" }, { destinationRef: "host/desk-b", label: "Reception team" }] }) };
}
