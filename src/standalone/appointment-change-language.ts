import type { MenuClarificationReason } from "../core/model.ts";

type Request = Readonly<{ kind: "request"; operation: "cancel" | "reschedule"; choice?: 1 | 2 | 3 }>;
type Clarification = Readonly<{ kind: "clarify"; reason: MenuClarificationReason }>;

/** Bounded operation syntax. A classifier cannot turn questions, disagreement,
 * mixed operations or patient reassignment into cancellation authority. */
export function appointmentChangeLanguage(text: string): Request | Clarification | undefined {
  const value = text.toLowerCase().replace(/[’]/g, "'").replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(?:someone else|another person|my (?:husband|wife|partner|friend))\b.*\b(?:take|use|slot|appointment)\b/.test(value) ||
      /\b(?:an hour|longer|shorter)\b.*\b(?:instead|visit|appointment)\b|\b(?:duration|change the type)\b/.test(value))
    return { kind: "clarify", reason: "changeUnsupported" };
  if (/\b(?:i thought|you (?:are saying|said)|are you sure|which appointment)\b/.test(value))
    return { kind: "clarify", reason: "targetDisagreement" };
  if (/\b(?:don't|do not|not|no|wait|hold on)\b.*\b(?:cancel|remove|delete)\b/.test(value))
    return { kind: "clarify", reason: "changeAmbiguous" };
  if (/\b(?:cancel|remove|delete)\b/.test(value) && /\b(?:move|reschedule|rebook|another day|different day|new time)\b/.test(value))
    return { kind: "clarify", reason: "changeAmbiguous" };
  if (/^(?:i (?:want|need|would like) to|please) change (?:that|the|my) (?:time|appointment|booking)(?: after all)?$/.test(value))
    return { kind: "clarify", reason: "proposalCorrection" };
  const request = value.match(/^(?:(?:actually|instead) )?(?:(?:please|could you|can you|i (?:want|need|would like) to) )?(cancel|remove|delete|move|reschedule)\b(.*)$/);
  if (!request) return undefined;
  const rest = request[2]!.trim();
  // Preserve a declared single target. Questions, group changes and identity
  // substitutions are not accepted by this syntax.
  if (!/^(?:(?:my|this|that|the|an|only the) (?:appointment|booking|visit|slot|first (?:visit|appointment)|second (?:visit|appointment)|third (?:visit|appointment))|it)(?: (?:please|thanks))?(?: i will arrange another visit myself| keep the first one)?$/.test(rest))
    return { kind: "clarify", reason: "changeAmbiguous" };
  const target = rest.replace(/ keep the first one$/, "");
  const choice = /\b(first|second|third)\b/.exec(target)?.[1];
  if (rest.endsWith(" keep the first one") && (!choice || choice === "first"))
    return { kind: "clarify", reason: "changeAmbiguous" };
  return { kind: "request", operation: ["move", "reschedule"].includes(request[1]!) ? "reschedule" : "cancel",
    ...(choice ? { choice: choice === "first" ? 1 : choice === "second" ? 2 : 3 } : {}) };
}
