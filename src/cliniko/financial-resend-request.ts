import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { financialIntentDigest } from "./financial-booking-observation.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import type { FinancialMessagePurpose } from "./financial-message-attempt.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";

/** Prospective private context only. Its independent approval, exact native
 * sources, current recipient/sender and complete history must still be checked.
 * A request record is neither permission nor proof that any message was sent. */
export type FinancialResendRequest = Readonly<{
  actionRef: string; effectRef: string; approvalRef: string; financialActionRef: string; purpose: FinancialMessagePurpose;
  intentRecallRef: string; intentDigest: string; observationRecallRef: string; observationActionRef: string; targetRef: string;
  checkoutAttemptRecallRef: string; checkoutAttemptActionRef: string; checkoutRef: string;
  selectionDigest: string; requestedAt: string; expiresAt: string;
}>;
const header = "Abby financial resend request v1";
const instruction = "Prospective context only. No send, payment or permission proof. Never replay an old effect.";
const invalid = () => err({ kind: "invalidResendRequest" as const });
const recall = (v: unknown) => typeof v === "string" && /^cliniko:recall:[1-9][0-9]{0,18}$/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function valid(a: FinancialResendRequest): boolean {
  if (!a || Object.keys(a).sort().join(",") !== "actionRef,approvalRef,checkoutAttemptActionRef,checkoutAttemptRecallRef,checkoutRef,effectRef,expiresAt,financialActionRef,intentDigest,intentRecallRef,observationActionRef,observationRecallRef,purpose,requestedAt,selectionDigest,targetRef" ||
      !["linkDelivery", "receiptDelivery"].includes(a.purpose)) return false;
  const actions = [a.actionRef, a.effectRef, a.approvalRef, a.financialActionRef, a.observationActionRef, a.checkoutAttemptActionRef];
  const sources = [a.intentRecallRef, a.observationRecallRef, a.checkoutAttemptRecallRef];
  return actions.every(validRecallMarker) && new Set(actions).size === actions.length && sources.every(recall) && new Set(sources).size === sources.length &&
    typeof a.targetRef === "string" && /^cliniko:(?:appointment|attendee):[1-9][0-9]{0,18}$/.test(a.targetRef) &&
    typeof a.checkoutRef === "string" && /^cs_(?:test_|live_)?[A-Za-z0-9]{1,200}$/.test(a.checkoutRef) &&
    [a.intentDigest, a.selectionDigest].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) &&
    instant(a.requestedAt) && instant(a.expiresAt) && a.expiresAt > a.requestedAt && Date.parse(a.expiresAt) - Date.parse(a.requestedAt) <= 86_400_000;
}
export function encodeFinancialResendRequest(a: FinancialResendRequest): Result<string, Readonly<{ kind: "invalidResendRequest" }>> {
  try {
    if (!valid(a)) return invalid();
    const payload = [a.effectRef, a.approvalRef, a.financialActionRef, a.purpose, a.intentRecallRef, a.intentDigest,
      a.observationRecallRef, a.observationActionRef, a.targetRef, a.checkoutAttemptRecallRef, a.checkoutAttemptActionRef,
      a.checkoutRef, a.selectionDigest, a.requestedAt, a.expiresAt];
    const summary = `${header}\n${JSON.stringify(payload)}\n${instruction}`;
    return validRecallSummary(summary) ? ok(formatRecallNote(a.actionRef, summary)) : invalid();
  } catch { return invalid(); }
}
export function decodeFinancialResendRequest(notes: unknown): Result<FinancialResendRequest, Readonly<{ kind: "invalidResendRequest" }>> {
  try {
    if (typeof notes !== "string" || notes.length > 1_050) return invalid();
    const lines = notes.split("\n");
    if (lines.length !== 4 || !lines[0]!.startsWith("Abby request ") || lines[1] !== header || lines[3] !== instruction) return invalid();
    const a: unknown = JSON.parse(lines[2]!); if (!Array.isArray(a) || a.length !== 15) return invalid();
    const value = { actionRef: lines[0]!.slice(13), effectRef: a[0], approvalRef: a[1], financialActionRef: a[2], purpose: a[3],
      intentRecallRef: a[4], intentDigest: a[5], observationRecallRef: a[6], observationActionRef: a[7], targetRef: a[8],
      checkoutAttemptRecallRef: a[9], checkoutAttemptActionRef: a[10], checkoutRef: a[11], selectionDigest: a[12], requestedAt: a[13], expiresAt: a[14] };
    const encoded = encodeFinancialResendRequest(value);
    return encoded.ok && encoded.value === notes ? ok(Object.freeze(value)) : invalid();
  } catch { return invalid(); }
}
export function resendRequestMatchesIntent(a: FinancialResendRequest, intent: ClinikoFinancialIntent, intentRecallRef: string): boolean {
  try {
    const digest = financialIntentDigest(intent);
    return valid(a) && typeof digest === "string" && a.financialActionRef === intent.actionRef && a.intentRecallRef === intentRecallRef &&
      a.intentDigest === digest && Date.parse(a.requestedAt) >= Date.parse(intent.createdAt) &&
      a.targetRef.startsWith(intent.booking.kind === "book" ? "cliniko:appointment:" : "cliniko:attendee:") &&
      [a.actionRef, a.effectRef, a.approvalRef, a.observationActionRef, a.checkoutAttemptActionRef]
        .every(id => ![intent.actionRef, intent.booking.actionRef, ...Object.values(intent.effects)].includes(id));
  } catch { return false; }
}
