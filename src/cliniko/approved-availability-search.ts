import { err, ok } from "../core/model.ts";
import type { AvailabilityRead, AvailabilityReadFailure, LocationScope, Result } from "../core/model.ts";
import type { AvailabilityHost } from "../core/host.ts";
import { ClinikoAvailabilityReader } from "./availability.ts";

/**
 * One bounded caller read. Try the approved primary first; only a no-time or
 * ineligible answer permits a labeled fallback. Any provider uncertainty stops
 * the search, so partial reads cannot be presented as a complete no-time result.
 */
export class ClinikoApprovedAvailabilitySearch implements AvailabilityHost {
  private readonly readers: readonly ClinikoAvailabilityReader[];
  private readonly now: () => string;

  constructor(readers: readonly ClinikoAvailabilityReader[], now: () => string = () => new Date().toISOString()) {
    if (!Array.isArray(readers) || readers.length < 1 || readers.length > 3 ||
        readers.some(reader => !(reader instanceof ClinikoAvailabilityReader))) {
      throw new TypeError("one to three Cliniko readers required");
    }
    this.readers = [...readers];
    this.now = now;
  }

  async list(scope: LocationScope, from: string, to: string): Promise<Result<AvailabilityRead, AvailabilityReadFailure>> {
    let empty: Extract<AvailabilityRead, { kind: "times" }> | undefined;
    let ineligible: Extract<AvailabilityRead, { kind: "notEligible" }> | undefined;
    let timeZone: string | undefined;
    let now: number;
    try { now = Date.parse(this.now()); }
    catch { return err({ kind: "unavailable" }); }
    if (!Number.isFinite(now)) return err({ kind: "unavailable" });

    for (let index = 0; index < this.readers.length; index += 1) {
      const result = index === 0
        ? await this.readers[index]!.list(scope, from, to)
        : await this.readers[index]!.listLabeled(scope, from, to);
      if (!result.ok) return result;
      if (result.value.kind === "notEligible") {
        ineligible ??= result.value;
        continue;
      }
      if (timeZone && result.value.timeZone !== timeZone) return err({ kind: "unavailable" });
      timeZone = result.value.timeZone;
      if (result.value.startsAt.some(start => Date.parse(start) > now)) return ok(result.value);
      empty ??= result.value;
    }
    return empty ? ok(empty) : ok(ineligible ?? { kind: "notEligible", reason: "business" });
  }
}
