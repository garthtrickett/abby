import { normalizedSpokenName } from "./spoken-name.ts";

export type LocationServices = readonly Readonly<{ locationId: string; services: readonly Readonly<{
  name: string; visitKind: "initial" | "followUp"; durationMinutes: number }>[] }>[];
/** Public metadata only: no provider IDs, paths, patient facts or slot claims. */
export function validLocationServices(ids: readonly string[], value: unknown): value is LocationServices {
  if (!Array.isArray(value) || value.length !== ids.length) return false;
  return value.every((location, index) => {
    if (!location || Object.keys(location).sort().join(",") !== "locationId,services" || location.locationId !== ids[index] ||
        !Array.isArray(location.services) || location.services.length < 1 || location.services.length > 12) return false;
    const seen = new Set<string>();
    return location.services.every((service: unknown) => {
      if (!service || typeof service !== "object" || Object.keys(service).sort().join(",") !== "durationMinutes,name,visitKind") return false;
      const row = service as Record<string, unknown>, name = normalizedSpokenName(row.name);
      if (!name || !["initial", "followUp"].includes(String(row.visitKind)) || !Number.isSafeInteger(row.durationMinutes) || Number(row.durationMinutes) < 1 || Number(row.durationMinutes) > 480) return false;
      const key = JSON.stringify([name, row.visitKind, row.durationMinutes]); if (seen.has(key)) return false; seen.add(key); return true;
    });
  });
}
