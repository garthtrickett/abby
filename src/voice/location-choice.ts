import type { FinalCallerTurn, PendingLocationRoute } from "../core/model.ts";
import { normalizedSpokenName, validPendingRoute } from "../core/pending-location.ts";

/** The route snapshot, rather than a later directory read, determines what the caller hears. */
export function locationChoicePrompt(route: PendingLocationRoute): string | undefined {
  if (!validPendingRoute(route)) return undefined;
  const names = route.candidateNames.map(candidate => candidate.spokenName.trim().replace(/\s+/gu, " "));
  return `Which location would you like? Please say ${names.slice(0, -1).join(", ")} or ${names.at(-1)}.`;
}

/** Fail closed: a final turn must name exactly one captured location. */
export function resolveLocationChoice(route: PendingLocationRoute, turn: FinalCallerTurn): string | undefined {
  if (!validPendingRoute(route) || !turn || typeof turn.text !== "string" || turn.quality !== "clear") return undefined;
  const words = turn.text.trim().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ").toLocaleLowerCase("en-AU");
  const candidate = words.replace(/^the /u, "").replace(/ location$/u, "");
  const normalized = normalizedSpokenName(candidate);
  return route.candidateNames.find(item => normalizedSpokenName(item.spokenName) === normalized)?.locationId;
}
