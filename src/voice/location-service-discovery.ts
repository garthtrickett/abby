import { normalizedSpokenName, validPendingRoute } from "../core/pending-location.ts";
import type { PendingLocationRoute } from "../core/model.ts";

/** A question never chooses a location, even if a service is listed at just one. */
export function locationServiceDiscovery(route: PendingLocationRoute, text: string): string | undefined {
  if (!validPendingRoute(route) || !route.candidateServices) return undefined;
  const value = text.trim().replace(/[.!?]+$/, "");
  if (value.length > 180 || /[\r\n"“”]/.test(value)) return undefined;
  const service = value.match(/^(?:Which locations? (?:offer|offers)|Where can I book) (.+)$/i);
  const location = value.match(/^What services (?:are listed|are available|do you offer) at (.+)$/i);
  if (!service && !location) return undefined;
  const descriptions = route.candidateServices.flatMap(row => {
    const label = route.candidateNames.find(name => name.locationId === row.locationId)!.spokenName;
    if (location && normalizedSpokenName(location[1]) !== normalizedSpokenName(label)) return [];
    const found = row.services.filter(item => !service || normalizedSpokenName(item.name) === normalizedSpokenName(service[1]));
    if (!found.length) return [];
    return [`${label} lists ${found.map(item => `${item.name}, ${item.visitKind === "initial" ? "initial" : "follow-up"}, ${item.durationMinutes} minutes`).join("; ")}.`];
  });
  return descriptions.length ? `${descriptions.join(" ")} These are listed services; appointment times still need to be checked.`
    : "I don't have that listed for these locations. Please contact the clinic if you need more information.";
}
