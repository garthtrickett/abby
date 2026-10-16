import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";
import { validLocationServices } from "../core/location-services.ts";
import type { ClinicNumberRoutingHost } from "../reference/clinic-number-routing.ts";
import { OwnerFileServiceCatalogue } from "./owner-file-service-catalogue.ts";

type Source = Parameters<typeof OwnerFileServiceCatalogue.capture>[0];
/** Enrich the existing number directory using independently approved location
 * catalogues. A changed source/membership changes the route version and cannot
 * silently bind a choice made over older service information. */
export class ClinikoLocationServiceDirectory implements ClinicNumberRoutingHost {
  readonly #base: ClinicNumberRoutingHost;
  readonly #sources: readonly Source[];
  constructor(base: ClinicNumberRoutingHost, sources: readonly Source[]) {
    if (typeof base?.identifyCall !== "function" || !Array.isArray(sources) || !sources.length || sources.length > 32) throw new TypeError("invalid location service directory");
    this.#base = base; this.#sources = Object.freeze(sources.map(source => Object.freeze({ ...source, scope: Object.freeze({ ...source.scope }) })));
  }
  async identifyCall(accountRef: string, dialedNumber: string) {
    const unavailable = () => err({ kind: "unavailable" as const });
    try {
      const base = await this.#base.identifyCall(accountRef, dialedNumber); if (!base.ok) return base;
      const identity = base.value;
      if (identity.candidateLocationIds.length < 2) return base;
      const services = [], bindings: string[] = [];
      for (const locationId of identity.candidateLocationIds) {
        const matching = this.#sources.filter(source => source.scope.tenantId === identity.tenantId && source.scope.clinicId === identity.clinicId && source.scope.locationId === locationId);
        if (matching.length !== 1) return unavailable();
        const captured = await OwnerFileServiceCatalogue.capture(matching[0]!); if (!captured.ok) return unavailable();
        const current = await captured.value.current(matching[0]!.scope);
        const name = identity.candidateNames?.find(candidate => candidate.locationId === locationId)?.spokenName;
        if (!current.ok || normalizedSpokenName(current.value.locationName) !== normalizedSpokenName(name)) return unavailable();
        bindings.push(captured.value.bindingFingerprint());
        services.push({ locationId, services: current.value.services.map(({ name, visitKind, durationMinutes }) => ({ name, visitKind, durationMinutes })) });
      }
      if (!validLocationServices(identity.candidateLocationIds, services)) return unavailable();
      const again = await this.#base.identifyCall(accountRef, dialedNumber);
      if (!again.ok || JSON.stringify(again.value) !== JSON.stringify(identity)) return unavailable();
      // Re-capture source identity to detect a change during this multi-source read.
      for (const [index, locationId] of identity.candidateLocationIds.entries()) {
        const source = this.#sources.find(source => source.scope.tenantId === identity.tenantId && source.scope.clinicId === identity.clinicId && source.scope.locationId === locationId)!;
        const captured = await OwnerFileServiceCatalogue.capture(source);
        if (!captured.ok || captured.value.bindingFingerprint() !== bindings[index]) return unavailable();
      }
      return ok({ ...identity, candidateServices: services, routeVersion: createHash("sha256").update(JSON.stringify([identity.routeVersion, bindings])).digest("hex") });
    } catch { return unavailable(); }
  }
}
