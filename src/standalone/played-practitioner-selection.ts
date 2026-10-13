import { normalizedSpokenName } from "../core/spoken-name.ts";
import type { CallState } from "../core/model.ts";
import type { ReschedulingPractitionerRead } from "../core/rescheduling-menu.ts";
import { noticePresentationId } from "../core/transition.ts";
import type { VoiceIntent } from "../voice/voice-session.ts";

/** Match only names/ordinals from the current played directory page. A model
 * never maps a spoken name to a provider ID or selects an unheard practitioner. */
export class PlayedPractitionerSelection {
  #menu: Readonly<{ turnId: string; snapshot: ReschedulingPractitionerRead }> | undefined;
  clear(): void { this.#menu = undefined; }
  remember(turnId: string, snapshot: ReschedulingPractitionerRead): void { this.#menu = structuredClone({ turnId, snapshot }); }
  resolve(text: string, state: CallState, now: string): VoiceIntent | undefined {
    const menu = this.#menu; if (!menu) return undefined;
    const raw = text.trim().replace(/[.!?,]+$/g, "").replace(/\s+(?:please|thanks)$/i, "");
    const ordinal = raw.match(/^(?:(?:the|with)\s+)?(?:option\s+)?(first|second|third|one|two|three|1|2|3)(?:\s+(?:one|practitioner))?$/i);
    const label = normalizedSpokenName(raw.replace(/^(?:(?:with|choose|see|switch to|can i see|i would like|i'd like)\s+)/i, ""));
    const index = ordinal ? ["first", "one", "1"].includes(ordinal[1]!.toLowerCase()) ? 0 : ["second", "two", "2"].includes(ordinal[1]!.toLowerCase()) ? 1 : 2
      : menu.snapshot.choices.findIndex(choice => normalizedSpokenName(choice.name) === label);
    if (!ordinal && index < 0) return undefined;
    const notice = state.presentations[noticePresentationId(state.callId, menu.turnId)];
    if (state.callId !== menu.snapshot.callId || state.sessionLease?.sessionId !== menu.snapshot.sessionId ||
        state.policy.policyVersion !== menu.snapshot.policyVersion || state.policy.scope.tenantId !== menu.snapshot.scope.tenantId ||
        state.policy.scope.clinicId !== menu.snapshot.scope.clinicId || state.policy.scope.locationId !== menu.snapshot.scope.locationId ||
        state.lifecycle !== "active" || state.pendingPresentationId || state.processedTurnIds.at(-1) !== menu.turnId ||
        notice?.kind !== "notice" || notice.status !== "played" || !Number.isFinite(Date.parse(now)) ||
        menu.snapshot.choices.some(choice => !Number.isFinite(Date.parse(choice.expiresAt)) || Date.parse(choice.expiresAt) <= Date.parse(now))) {
      return { kind: "clarify", reason: "menuUnavailable" };
    }
    return index >= 0 && index < menu.snapshot.choices.length ? { kind: "reschedulingChoice", stage: "practitioners", choice: (index + 1) as 1 | 2 | 3 }
      : { kind: "clarify", reason: "menuAmbiguous" };
  }
}
