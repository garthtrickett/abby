import { randomUUID } from "node:crypto";
import type { CallState, FinalCallerTurn } from "../core/model.ts";
import type { ClassServiceQuestion } from "../core/class-service-question.ts";
import { noticePresentationId } from "../core/notice-presentation-id.ts";
import type { VoiceIntent } from "../voice/voice-session.ts";
import { classServiceName } from "./class-service-catalogue.ts";
import type { ClassServices, ClassServiceItem } from "./class-service-catalogue.ts";

type Pending = Readonly<{ turnId: string; revision: number; version: string; operation: "book" | "cancel"; page: number; expiresAt: number }>;
type Selection = Readonly<{ turnId: string; item: ClassServiceItem; version: string; operation: "book" | "cancel"; callId: string; sessionId: string; revision: number; expiresAt: number }>;
const denied = { kind: "clarify", reason: "serviceSelectionUnavailable" } as const;

/** Volatile public service selection. Private handles bind an exact current
 * catalogue to one call/turn/operation; numbered choices require played speech. */
export class ClassServiceDialogue {
  #pending: Pending | undefined;
  #selected = new Map<string, Selection>();
  get operation() { return this.#pending?.operation; }
  get active() { return this.#pending !== undefined; }
  clear() { this.#pending = undefined; this.#selected.clear(); }
  #valid(turn: FinalCallerTurn, state: CallState, now: string) {
    return turn.quality === "clear" && state.lifecycle === "active" && !state.callerIdentityDenied && turn.callId === state.callId &&
      turn.sessionId === state.sessionLease?.sessionId && Number.isFinite(Date.parse(now)) && Date.parse(state.sessionLease!.expiresAt) > Date.parse(now) && !state.processedTurnIds.includes(turn.turnId);
  }
  #question(turn: FinalCallerTurn, state: CallState, catalogue: ClassServices, operation: "book" | "cancel", page: number, now: string): VoiceIntent {
    const expiresAt = Math.min(Date.parse(now) + 120_000, Date.parse(catalogue.expiresAt));
    this.#pending = { turnId: turn.turnId, revision: state.conversationRevision, version: catalogue.version, operation, page, expiresAt };
    const question: ClassServiceQuestion = { operation, labels: catalogue.items.slice(page * 3, page * 3 + 3).map(item => item.label), page: page + 1,
      pages: Math.ceil(catalogue.items.length / 3), expiresAt: new Date(expiresAt).toISOString() };
    return { kind: "classServiceQuestion", question };
  }
  #choose(turn: FinalCallerTurn, state: CallState, catalogue: ClassServices, operation: "book" | "cancel", item: ClassServiceItem, now: string): VoiceIntent {
    const ref = `class-service:${randomUUID()}`;
    this.#pending = undefined; this.#selected.clear();
    this.#selected.set(ref, { turnId: turn.turnId, item, version: catalogue.version, operation, callId: turn.callId, sessionId: turn.sessionId!, revision: state.conversationRevision,
      expiresAt: Math.min(Date.parse(now) + 120_000, Date.parse(catalogue.expiresAt)) });
    return { kind: "workflow", operation, classAttendance: true, classSelectionRef: ref };
  }
  resolve(turn: FinalCallerTurn, state: CallState, catalogue: ClassServices, now: string, requested?: Readonly<{ operation: "book" | "cancel"; name?: string }>): VoiceIntent | undefined {
    if (!requested && !this.#pending) return undefined;
    if (!this.#valid(turn, state, now)) { this.clear(); return denied; }
    if (requested) {
      this.clear();
      const wanted = requested.name && classServiceName(requested.name);
      const matched = wanted ? catalogue.items.filter(item => [item.public.className, item.label].some(name => classServiceName(name) === wanted)) : [];
      if (matched.length === 1) return this.#choose(turn, state, catalogue, requested.operation, matched[0]!, now);
      if (wanted && !matched.length) return denied;
      if (catalogue.items.length === 1) return this.#choose(turn, state, catalogue, requested.operation, catalogue.items[0]!, now);
      return this.#question(turn, state, catalogue, requested.operation, 0, now);
    }
    const pending = this.#pending!;
    const notice = state.presentations[noticePresentationId(state.callId, pending.turnId)];
    if (pending.version !== catalogue.version || pending.expiresAt <= Date.parse(now) || state.pendingPresentationId || state.processedTurnIds.at(-1) !== pending.turnId ||
        state.conversationRevision < pending.revision + 1 || state.conversationRevision > pending.revision + 3 || notice?.status !== "played" || notice.kind !== "notice") {
      this.clear(); return denied;
    }
    const answer = classServiceName(turn.text).replace(/ please$/, "");
    if (/^(?:the )?next (?:class )?services$/.test(answer)) return pending.page + 1 < Math.ceil(catalogue.items.length / 3)
      ? this.#question(turn, state, catalogue, pending.operation, pending.page + 1, now) : denied;
    if (/^(?:the )?previous (?:class )?services$/.test(answer)) return pending.page > 0
      ? this.#question(turn, state, catalogue, pending.operation, pending.page - 1, now) : denied;
    const ordinal = /^(?:the )?(?:option )?(first|second|third|one|two|three|1|2|3)(?: (?:class|service|one))?$/.exec(answer);
    const index = ordinal ? (["first", "one", "1"].includes(ordinal[1]!) ? 0 : ["second", "two", "2"].includes(ordinal[1]!) ? 1 : 2) : undefined;
    const page = catalogue.items.slice(pending.page * 3, pending.page * 3 + 3);
    const named = page.filter(item => [item.public.className, item.label].some(name => classServiceName(name) === answer));
    const selected = index !== undefined ? page[index] : named.length === 1 ? named[0] : undefined;
    if (!selected) return this.#question(turn, state, catalogue, pending.operation, pending.page, now);
    return this.#choose(turn, state, catalogue, pending.operation, selected, now);
  }
  take(ref: string, operation: "book" | "cancel", state: CallState, catalogue: ClassServices, now: string, turnId?: string): ClassServiceItem | undefined {
    const selection = this.#selected.get(ref); this.#selected.delete(ref);
    return selection && selection.turnId === turnId && selection.operation === operation && selection.callId === state.callId && selection.sessionId === state.sessionLease?.sessionId &&
      selection.revision === state.conversationRevision && selection.version === catalogue.version && selection.expiresAt > Date.parse(now) &&
      catalogue.items.some(item => item.public.serviceRef === selection.item.public.serviceRef && JSON.stringify(item.approval) === JSON.stringify(selection.item.approval))
      ? selection.item : undefined;
  }
}
