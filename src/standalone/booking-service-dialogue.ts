import { eligibleServicePractitioners, servicePractitionerPreferenceLanguage } from "./service-practitioner-preference.ts";
import type { BookingServiceChoice } from "../core/booking-service-choice.ts";
import type { BookingServiceQuestion } from "../core/booking-service-question.ts";
import type { CallState, FinalCallerTurn } from "../core/model.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";
import { noticePresentationId } from "../core/transition.ts";
import type { VoiceIntent } from "../voice/voice-session.ts";
import type { ApprovedBookingService } from "./owner-file-service-catalogue.ts";

type Pending = Readonly<{ turnId: string; revision: number; question: BookingServiceQuestion; catalogue: string; expiresAt: number }>;
const changed = { kind: "clarify", reason: "serviceChoiceChanged" } as const;
export function startsServiceDialogue(text: string): boolean {
  return /^(?:(?:please |i would like to |i want to |i'd like to )?book(?: me)? (?:an? )?appointment|(?:i would like|i want|i'd like) an? appointment)[.!?]*$/i.test(text.trim());
}
const clean = (text: string) => text.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/,? please$/, "");
const durations: Record<string, number> = { "half an hour": 30, "thirty minutes": 30, "forty-five minutes": 45,
  "forty five minutes": 45, "an hour": 60, "one hour": 60, "sixty minutes": 60, "an hour and a half": 90, "ninety minutes": 90 };

/** Volatile, receipt-bound dialogue. Answers are caller attestations, never
 * provider history; an interrupted question cannot advance the selection. */
export class BookingServiceDialogue {
  #pending: Pending | undefined;
  #choice: { -readonly [K in keyof BookingServiceChoice]?: BookingServiceChoice[K] } = {};
  get active() { return this.#pending !== undefined; }
  clear() { this.#pending = undefined; this.#choice = {}; }
  resolve(turn: FinalCallerTurn, state: CallState, services: readonly ApprovedBookingService[], catalogue: string, now: string): VoiceIntent | undefined {
    if (/^(?:please )?(?:cancel|reschedule|move|change) (?:my |the |an? )?appointment[.!?]*$/i.test(turn.text.trim())) { this.clear(); return undefined; }
    const start = startsServiceDialogue(turn.text), previous = this.#pending;
    if (!start && !previous) return undefined;
    if (turn.quality !== "clear" || state.lifecycle !== "active" || state.callerIdentityDenied || turn.callId !== state.callId ||
        turn.sessionId !== state.sessionLease?.sessionId || !Number.isFinite(Date.parse(now)) || (!Number.isFinite(Date.parse(state.sessionLease?.expiresAt ?? "")) || Date.parse(state.sessionLease!.expiresAt) <= Date.parse(now)) ||
        state.processedTurnIds.includes(turn.turnId)) return changed;
    if (start) this.clear();
    else {
      const notice = state.presentations[noticePresentationId(state.callId, previous!.turnId)];
      if (previous!.expiresAt <= Date.parse(now) || previous!.catalogue !== catalogue || state.pendingPresentationId || (state.conversationRevision < previous!.revision + 2 || state.conversationRevision > previous!.revision + 3) ||
          state.processedTurnIds.at(-1) !== previous!.turnId || notice?.kind !== "notice" || notice.status !== "played") { this.clear(); return changed; }
      const correction = clean(turn.text).match(/^actually,? (.+)$/);
      const corrected = correction?.[1];
      if (corrected) {
        const name = services.find(service => normalizedSpokenName(service.name) === normalizedSpokenName(corrected));
        if (name) this.#choice = { name: name.name };
        else if (/^(?:an? )?(?:initial|initial assessment|first appointment)$/.test(corrected) && this.#choice.name)
          this.#choice = { name: this.#choice.name, visitKind: "initial" };
        else if (/^(?:an? )?(?:follow-up|follow up)(?: appointment)?$/.test(corrected) && this.#choice.name)
          this.#choice = { name: this.#choice.name, visitKind: "followUp" };
      }
      const answer = clean(turn.text), field = previous!.question.field;
      if (field === "name") {
        const name = previous!.question.options.find(name => normalizedSpokenName(name) === normalizedSpokenName(answer));
        if (name) this.#choice.name = name;
      } else if (field === "visitKind") {
        const kind = /^(?:initial|initial assessment|first appointment|first visit|i have never been|i've never been)$/.test(answer) ? "initial"
          : /^(?:follow-up|follow up|follow-up appointment|follow up appointment)$/.test(answer) ? "followUp" : undefined;
        if (kind && previous!.question.options.includes(kind)) this.#choice.visitKind = kind;
      } else if (field === "durationMinutes") {
        const number = durations[answer] ?? (/^\d{1,3}(?: minutes?)?$/.test(answer) ? Number(answer.split(" ")[0]) : undefined);
        if (number && previous!.question.options.includes(String(number))) this.#choice.durationMinutes = number;
      } else if (field === "returningPatient") {
        if (/^(?:yes|yes i have|i have been before|i am a returning patient)$/.test(answer)) this.#choice.returningPatient = true;
        else if (/^(?:no|no i haven't|i have never been|i've never been|i am a new patient)$/.test(answer)) this.#choice.returningPatient = false;
      } else if (field === "newProblem") {
        if (/^(?:yes|yes it is|it is a new problem|this is a new problem)$/.test(answer)) this.#choice.newProblem = true;
        else if (/^(?:no|no it isn't|it is not a new problem|this is not a new problem)$/.test(answer)) this.#choice.newProblem = false;
      } else if (field === "practitionerPreference") {
        const preference = servicePractitionerPreferenceLanguage(turn.text, true);
        const service = services.find(service => normalizedSpokenName(service.name) === normalizedSpokenName(this.#choice.name) &&
          service.visitKind === this.#choice.visitKind && service.durationMinutes === this.#choice.durationMinutes);
        if (preference && service && eligibleServicePractitioners(service.practitioners, preference).length) this.#choice.practitionerPreference = Object.freeze({ ...preference });
        else if (preference?.kind === "gender") { this.clear(); return { kind: "clarify", reason: "searchPreferenceUnavailable" }; }
      } else {
        const months = answer.match(/^(?:(?:my last visit was|it was) )?(\d{1,4})(?: months?(?: ago)?)?$/);
        if (months && Number(months[1]) <= 2400) this.#choice.monthsSinceLastVisit = Number(months[1]);
      }
    }
    const choice = this.#choice;
    const candidates = services.filter(service => (!choice.name || normalizedSpokenName(service.name) === normalizedSpokenName(choice.name)) &&
      (!choice.visitKind || service.visitKind === choice.visitKind) && (!choice.durationMinutes || service.durationMinutes === choice.durationMinutes));
    if (!candidates.length) { this.clear(); return changed; }
    let question: BookingServiceQuestion | undefined;
    const options = (values: readonly string[]) => values.filter((value, index) => values.findIndex(other => normalizedSpokenName(other) === normalizedSpokenName(value)) === index);
    if (!choice.name) question = { field: "name", options: options(candidates.map(service => service.name)) };
    else if (!choice.visitKind) question = { field: "visitKind", options: options(candidates.map(service => service.visitKind)) };
    else if (!choice.durationMinutes) question = { field: "durationMinutes", options: options(candidates.map(service => String(service.durationMinutes))).sort((a, b) => Number(a) - Number(b)) };
    else {
      const rule = candidates[0]!.followUpRule;
      if (rule?.returningRequired && choice.returningPatient === undefined) question = { field: "returningPatient", options: [] };
      else if (rule?.returningRequired && choice.returningPatient !== true) { this.clear(); return changed; }
      else if (rule?.newProblemRequiresInitial && choice.newProblem === undefined) question = { field: "newProblem", options: [] };
      else if (rule?.newProblemRequiresInitial && choice.newProblem !== false) { this.clear(); return changed; }
      else if (rule?.maxMonthsSinceLastVisit !== null && rule?.maxMonthsSinceLastVisit !== undefined && choice.monthsSinceLastVisit === undefined)
        question = { field: "monthsSinceLastVisit", options: [] };
      else if (rule?.maxMonthsSinceLastVisit !== null && rule?.maxMonthsSinceLastVisit !== undefined && choice.monthsSinceLastVisit! > rule.maxMonthsSinceLastVisit) { this.clear(); return changed; }
    }
    if (!question && !choice.practitionerPreference) question = { field: "practitionerPreference", options: candidates[0]!.practitioners.map(member => member.name) };
    if (question) {
      this.#pending = { turnId: turn.turnId, revision: state.conversationRevision, question, catalogue, expiresAt: Date.parse(now) + 120_000 };
      return { kind: "serviceQuestion", question };
    }
    const complete = { ...choice } as BookingServiceChoice; this.clear();
    return { kind: "workflow", operation: "book", serviceChoice: complete };
  }
}
