import type { CallState } from "../core/model.ts";
import type { StaffMessageNotice } from "../core/staff-message-notice.ts";
import { noticePresentationId } from "../core/transition.ts";

type MessageTurn = Readonly<{ kind: "begin" | "send" | "discard" | "question" }> | Readonly<{ kind: "replace" | "add"; text: string }>;
/** Literal content stays private and transient. A model cannot create a draft
 * or turn a question, yes, or unplayed prompt into permission to send it. */
export function staffMessageLanguage(text: string, collecting = false): MessageTurn | undefined {
  const value = text.trim(), command = value.replace(/[.!?]+$/, "");
  if (/^(?:I would like to leave|I'd like to leave|Please take|Please collect) (?:a detailed|my detailed|my) message$/i.test(command)) return { kind: "begin" };
  if (collecting && (/^(?:Please )?(?:send|pass) (?:the|my|that) message$/i.test(command) || /^Please send that request$/i.test(command))) return { kind: "send" };
  if (/^(?:Please )?(?:discard|stop|don't send|do not send) (?:the|my|that) message$/i.test(command)) return { kind: "discard" };
  const replace = value.match(/^(?:Please replace (?:the|my) message with|The message is|Actually,? the message is):?\s+(.+)$/is);
  if (replace) return { kind: "replace", text: replace[1]!.trim() };
  const add = value.match(/^(?:Please add|Also,? please add|Also):?\s+(.+)$/is);
  if (add) return { kind: "add", text: add[1]!.trim() };
  if (/^(?:could|can) you make sure they send it (?:by email|to my email)(?:,? please)?[.!?]?$/i.test(value) ||
    /^(?:Please )?(?:call|contact) me (?:after|before) \d{1,2}(?::\d{2})? ?(?:am|pm)? (?:today|tomorrow)(?:,? please)?[.!?]?$/i.test(value)) return { kind: "add", text: value };
  if (!collecting) return undefined;
  // Unsupported commands/questions cannot silently become message content.
  if (/^(?:yes|no|okay|ok|hello|thanks|thank you|goodbye|bye)$/i.test(command) || /\?$/.test(value) || /^(?:did|have|has|is|are|can|could|would|when|what|how|send|cancel|book|reschedule|please|don't|do not)\b/i.test(value)) return { kind: "question" };
  return { kind: "replace", text: value };
}
export type PrivateStaffMessage = Readonly<{ text: string; turnIds: readonly string[] }>;
export class StaffMessageDraft {
  #text = "";
  #turnIds: string[] = [];
  #last: Readonly<{ turnId: string; revision: number }> | undefined;
  get active() { return this.#last !== undefined; }
  clear() { this.#text = ""; this.#turnIds = []; this.#last = undefined; }
  apply(turn: MessageTurn, turnId: string, revision: number): StaffMessageNotice {
    if (turn.kind === "discard") { this.clear(); return "discarded"; }
    if (turn.kind === "begin") { this.clear(); this.#last = { turnId, revision }; return "collecting"; }
    if (!this.active) return "notReady";
    if (turn.kind === "question") { this.#last = { turnId, revision }; return "notReady"; }
    if (!("text" in turn)) return "notReady";
    const text = turn.kind === "add" && this.#text ? `${this.#text}\n${turn.text}` : turn.text;
    if (!text || text.length > 350 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return "tooLong";
    this.#text = text; this.#turnIds = turn.kind === "add" ? [...this.#turnIds, turnId] : [turnId];
    this.#last = { turnId, revision }; return "updated";
  }
  ready(state: CallState): PrivateStaffMessage | undefined {
    const last = this.#last;
    if (!last || !this.#text || state.pendingPresentationId || (state.conversationRevision < last.revision || state.conversationRevision > last.revision + 1) || state.processedTurnIds.at(-1) !== last.turnId ||
      state.presentations[noticePresentationId(state.callId, last.turnId)]?.status !== "played" ||
      !this.#turnIds.every(id => state.processedTurnIds.includes(id))) return undefined;
    return { text: this.#text, turnIds: [...this.#turnIds] };
  }
}
