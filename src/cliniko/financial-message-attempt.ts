import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { financialIntentDigest } from "./financial-booking-observation.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";

export type FinancialMessagePurpose = "linkDelivery" | "receiptDelivery";
/** Private possible-send evidence. It establishes neither delivery, money,
 * permission nor an immutable recipient. An old attempt never authorizes retry. */
export type FinancialMessageAttempt = Readonly<{
  actionRef: string; financialActionRef: string; effectRef: string; purpose: FinancialMessagePurpose;
  intentRecallRef: string; intentDigest: string; observationRecallRef: string; observationActionRef: string;
  targetRef: string; checkoutRef: string; payloadDigest: string; attemptedAt: string;
}>;
const header = "Abby financial message attempt v1";
const instruction = "Possible send only. No delivery or payment proof. Never retry from absence.";
const invalid = (): Result<never, Readonly<{ kind: "invalidMessageAttempt" }>> => err({ kind: "invalidMessageAttempt" });
function valid(a: FinancialMessageAttempt): boolean {
  if (!a || Object.keys(a).sort().join(",") !== "actionRef,attemptedAt,checkoutRef,effectRef,financialActionRef,intentDigest,intentRecallRef,observationActionRef,observationRecallRef,payloadDigest,purpose,targetRef" ||
      ![a.actionRef, a.financialActionRef, a.effectRef, a.observationActionRef].every(validRecallMarker) ||
      new Set([a.actionRef, a.financialActionRef, a.effectRef, a.observationActionRef]).size !== 4 ||
      ![a.intentRecallRef, a.observationRecallRef, a.targetRef, a.checkoutRef, a.intentDigest, a.payloadDigest, a.attemptedAt].every(v => typeof v === "string") ||
      !["linkDelivery", "receiptDelivery"].includes(a.purpose) ||
      ![a.intentRecallRef, a.observationRecallRef].every(v => /^cliniko:recall:[1-9][0-9]{0,18}$/.test(v)) || a.intentRecallRef === a.observationRecallRef ||
      !/^cliniko:(?:appointment|attendee):[1-9][0-9]{0,18}$/.test(a.targetRef) || !/^cs_(?:test_|live_)?[A-Za-z0-9]{1,200}$/.test(a.checkoutRef) ||
      ![a.intentDigest, a.payloadDigest].every(v => /^[a-f0-9]{64}$/.test(v)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(a.attemptedAt)) return false;
  const at = Date.parse(a.attemptedAt); return Number.isFinite(at) && at >= 0 && new Date(at).toISOString() === a.attemptedAt;
}
export function encodeFinancialMessageAttempt(a: FinancialMessageAttempt): Result<string, Readonly<{ kind: "invalidMessageAttempt" }>> {
  if (!valid(a)) return invalid();
  const values = [a.financialActionRef, a.effectRef, a.purpose, a.intentRecallRef, a.intentDigest, a.observationRecallRef,
    a.observationActionRef, a.targetRef, a.checkoutRef, a.payloadDigest, a.attemptedAt];
  const summary = `${header}\n${JSON.stringify(values)}\n${instruction}`;
  return validRecallSummary(summary) ? ok(formatRecallNote(a.actionRef, summary)) : invalid();
}
export function decodeFinancialMessageAttempt(notes: unknown): Result<FinancialMessageAttempt, Readonly<{ kind: "invalidMessageAttempt" }>> {
  try {
    if (typeof notes !== "string" || notes.length > 1_050) return invalid();
    const lines = notes.split("\n");
    if (lines.length !== 4 || lines[1] !== header || lines[3] !== instruction || !lines[0]!.startsWith("Abby request ")) return invalid();
    const a: unknown = JSON.parse(lines[2]!); if (!Array.isArray(a) || a.length !== 11) return invalid();
    const value = { actionRef: lines[0]!.slice(13), financialActionRef: a[0], effectRef: a[1], purpose: a[2], intentRecallRef: a[3], intentDigest: a[4],
      observationRecallRef: a[5], observationActionRef: a[6], targetRef: a[7], checkoutRef: a[8], payloadDigest: a[9], attemptedAt: a[10] };
    const encoded = encodeFinancialMessageAttempt(value);
    return encoded.ok && encoded.value === notes ? ok(Object.freeze(value)) : invalid();
  } catch { return invalid(); }
}
export function messageAttemptMatchesIntent(a: FinancialMessageAttempt, intent: ClinikoFinancialIntent, intentRecallRef: string): boolean {
  return valid(a) && a.financialActionRef === intent.actionRef && a.effectRef === intent.effects[a.purpose] &&
    a.intentRecallRef === intentRecallRef && a.intentDigest === financialIntentDigest(intent) &&
    Date.parse(a.attemptedAt) >= Date.parse(intent.createdAt) &&
    ![intent.actionRef, intent.booking.actionRef, ...Object.values(intent.effects)].includes(a.actionRef) &&
    ![intent.actionRef, intent.booking.actionRef, ...Object.values(intent.effects)].includes(a.observationActionRef) &&
    a.targetRef.startsWith(intent.booking.kind === "book" ? "cliniko:appointment:" : "cliniko:attendee:");
}
