import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import { financialIntentDigest } from "./financial-booking-observation.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";

/** Private provider-owned evidence of a possible checkout dispatch, never proof
 * of dispatch, creation, money, current authorization or permission to retry. */
export type FinancialCheckoutAttempt = Readonly<{
  actionRef: string; financialActionRef: string; effectRef: string; intentRecallRef: string; intentDigest: string;
  observationRecallRef: string; observationActionRef: string; targetRef: string;
  requestDigest: string; createdFrom: number; createdThrough: number;
}>;
const header = "Abby financial checkout attempt v1";
const instruction = "Possible attempt only. Never retry creation from absence.";
const invalid = (): Result<never, Readonly<{ kind: "invalidCheckoutAttempt" }>> => err({ kind: "invalidCheckoutAttempt" });
function valid(a: FinancialCheckoutAttempt): boolean {
  return !!a && Object.keys(a).sort().join(",") === "actionRef,createdFrom,createdThrough,effectRef,financialActionRef,intentDigest,intentRecallRef,observationActionRef,observationRecallRef,requestDigest,targetRef" &&
    [a.actionRef, a.financialActionRef, a.effectRef, a.observationActionRef].every(validRecallMarker) &&
    new Set([a.actionRef, a.financialActionRef, a.effectRef, a.observationActionRef]).size === 4 &&
    [a.intentRecallRef, a.observationRecallRef, a.targetRef, a.intentDigest, a.requestDigest].every(v => typeof v === "string") &&
    [a.intentRecallRef, a.observationRecallRef].every(v => /^cliniko:recall:[1-9][0-9]{0,18}$/.test(v)) && a.intentRecallRef !== a.observationRecallRef &&
    /^cliniko:(?:appointment|attendee):[1-9][0-9]{0,18}$/.test(a.targetRef) &&
    [a.intentDigest, a.requestDigest].every(v => /^[a-f0-9]{64}$/.test(v)) &&
    Number.isSafeInteger(a.createdFrom) && a.createdFrom >= 0 && Number.isSafeInteger(a.createdThrough) &&
    a.createdThrough > a.createdFrom && a.createdThrough - a.createdFrom <= 86_400 && a.createdThrough <= 253_402_300_799;
}
export function encodeFinancialCheckoutAttempt(a: FinancialCheckoutAttempt): Result<string, Readonly<{ kind: "invalidCheckoutAttempt" }>> {
  if (!valid(a)) return invalid();
  const data = [a.financialActionRef, a.effectRef, a.intentRecallRef, a.intentDigest, a.observationRecallRef,
    a.observationActionRef, a.targetRef, a.requestDigest, a.createdFrom, a.createdThrough];
  const summary = `${header}\n${JSON.stringify(data)}\n${instruction}`;
  return validRecallSummary(summary) ? ok(formatRecallNote(a.actionRef, summary)) : invalid();
}
export function decodeFinancialCheckoutAttempt(notes: unknown): Result<FinancialCheckoutAttempt, Readonly<{ kind: "invalidCheckoutAttempt" }>> {
  try {
    if (typeof notes !== "string" || notes.length > 1_050) return invalid();
    const lines = notes.split("\n");
    if (lines.length !== 4 || lines[1] !== header || lines[3] !== instruction || !lines[0]!.startsWith("Abby request ")) return invalid();
    const a: unknown = JSON.parse(lines[2]!);
    if (!Array.isArray(a) || a.length !== 10) return invalid();
    const value = { actionRef: lines[0]!.slice(13), financialActionRef: a[0], effectRef: a[1], intentRecallRef: a[2], intentDigest: a[3],
      observationRecallRef: a[4], observationActionRef: a[5], targetRef: a[6], requestDigest: a[7], createdFrom: a[8], createdThrough: a[9] };
    const encoded = encodeFinancialCheckoutAttempt(value);
    return encoded.ok && encoded.value === notes ? ok(Object.freeze(value)) : invalid();
  } catch { return invalid(); }
}
export function checkoutAttemptMatchesIntent(a: FinancialCheckoutAttempt, intent: ClinikoFinancialIntent, intentRecallRef: string): boolean {
  return valid(a) && a.financialActionRef === intent.actionRef && a.effectRef === intent.effects.checkout &&
    a.intentRecallRef === intentRecallRef && a.intentDigest === financialIntentDigest(intent) &&
    ![intent.actionRef, intent.booking.actionRef, ...Object.values(intent.effects)].includes(a.actionRef) &&
    ![intent.actionRef, intent.booking.actionRef, ...Object.values(intent.effects)].includes(a.observationActionRef) &&
    a.targetRef.startsWith(intent.booking.kind === "book" ? "cliniko:appointment:" : "cliniko:attendee:");
}
