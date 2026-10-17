import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { financialResendRequestDigest, resendRequestMatchesIntent } from "./financial-resend-request.ts";
import type { FinancialResendRequest } from "./financial-resend-request.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import type { FinancialMessagePurpose } from "./financial-message-attempt.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";

/** Native possible-dispatch evidence, never delivery, money or resend authority.
 * Request/approval/effect identities survive a missing local exclusion. */
export type FinancialResendAttempt = Readonly<{
  actionRef: string; financialActionRef: string; effectRef: string; approvalRef: string;
  requestRecallRef: string; requestActionRef: string; requestDigest: string; purpose: FinancialMessagePurpose;
  intentRecallRef: string; intentDigest: string; observationRecallRef: string; observationActionRef: string;
  targetRef: string; checkoutRef: string; payloadDigest: string; attemptedAt: string;
}>;
const header = "Abby financial resend attempt v1";
const instruction = "Possible resend only. No delivery or payment proof. Never replay an old approval or effect.";
const invalid = () => err({ kind: "invalidResendAttempt" as const });
const recall = (v: unknown) => typeof v === "string" && /^cliniko:recall:[1-9][0-9]{0,18}$/.test(v);
function valid(a: FinancialResendAttempt): boolean {
  if (!a || Object.keys(a).sort().join(",") !== "actionRef,approvalRef,attemptedAt,checkoutRef,effectRef,financialActionRef,intentDigest,intentRecallRef,observationActionRef,observationRecallRef,payloadDigest,purpose,requestActionRef,requestDigest,requestRecallRef,targetRef" ||
      !["linkDelivery", "receiptDelivery"].includes(a.purpose)) return false;
  const actions = [a.actionRef, a.financialActionRef, a.effectRef, a.approvalRef, a.requestActionRef, a.observationActionRef];
  const refs = [a.requestRecallRef, a.intentRecallRef, a.observationRecallRef];
  return actions.every(validRecallMarker) && new Set(actions).size === actions.length && refs.every(recall) && new Set(refs).size === refs.length &&
    [a.requestDigest, a.intentDigest, a.payloadDigest].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) &&
    typeof a.targetRef === "string" && /^cliniko:(?:appointment|attendee):[1-9][0-9]{0,18}$/.test(a.targetRef) &&
    typeof a.checkoutRef === "string" && /^cs_(?:test_|live_)?[A-Za-z0-9]{1,200}$/.test(a.checkoutRef) &&
    typeof a.attemptedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(a.attemptedAt) &&
    Number.isFinite(Date.parse(a.attemptedAt)) && new Date(a.attemptedAt).toISOString() === a.attemptedAt;
}
export function encodeFinancialResendAttempt(a: FinancialResendAttempt): Result<string, Readonly<{ kind: "invalidResendAttempt" }>> {
  try {
    if (!valid(a)) return invalid();
    const payload = [a.financialActionRef, a.effectRef, a.approvalRef, a.requestRecallRef, a.requestActionRef, a.requestDigest,
      a.purpose, a.intentRecallRef, a.intentDigest, a.observationRecallRef, a.observationActionRef, a.targetRef, a.checkoutRef, a.payloadDigest, a.attemptedAt];
    const summary = `${header}\n${JSON.stringify(payload)}\n${instruction}`;
    return validRecallSummary(summary) ? ok(formatRecallNote(a.actionRef, summary)) : invalid();
  } catch { return invalid(); }
}
export function decodeFinancialResendAttempt(notes: unknown): Result<FinancialResendAttempt, Readonly<{ kind: "invalidResendAttempt" }>> {
  try {
    if (typeof notes !== "string" || notes.length > 1_050) return invalid(); const lines = notes.split("\n");
    if (lines.length !== 4 || !lines[0]!.startsWith("Abby request ") || lines[1] !== header || lines[3] !== instruction) return invalid();
    const a: unknown = JSON.parse(lines[2]!); if (!Array.isArray(a) || a.length !== 15) return invalid();
    const value = { actionRef: lines[0]!.slice(13), financialActionRef: a[0], effectRef: a[1], approvalRef: a[2], requestRecallRef: a[3],
      requestActionRef: a[4], requestDigest: a[5], purpose: a[6], intentRecallRef: a[7], intentDigest: a[8], observationRecallRef: a[9],
      observationActionRef: a[10], targetRef: a[11], checkoutRef: a[12], payloadDigest: a[13], attemptedAt: a[14] };
    const encoded = encodeFinancialResendAttempt(value); return encoded.ok && encoded.value === notes ? ok(Object.freeze(value)) : invalid();
  } catch { return invalid(); }
}
export function resendAttemptMatchesRequest(a: FinancialResendAttempt, request: FinancialResendRequest,
  requestRecallRef: string, intent: ClinikoFinancialIntent): boolean {
  try {
    return valid(a) && recall(requestRecallRef) && resendRequestMatchesIntent(request, intent, request.intentRecallRef) &&
      a.requestRecallRef === requestRecallRef && ![request.intentRecallRef, request.observationRecallRef, request.checkoutAttemptRecallRef].includes(requestRecallRef) &&
      a.requestActionRef === request.actionRef && a.requestDigest === financialResendRequestDigest(request) && a.approvalRef === request.approvalRef &&
      a.financialActionRef === request.financialActionRef && a.effectRef === request.effectRef && a.purpose === request.purpose &&
      a.intentRecallRef === request.intentRecallRef && a.intentDigest === request.intentDigest && a.observationRecallRef === request.observationRecallRef &&
      a.observationActionRef === request.observationActionRef && a.targetRef === request.targetRef && a.checkoutRef === request.checkoutRef &&
      a.attemptedAt >= request.requestedAt && a.attemptedAt < request.expiresAt &&
      ![intent.actionRef, intent.booking.actionRef, ...Object.values(intent.effects), request.actionRef, request.effectRef, request.approvalRef,
        request.observationActionRef, request.checkoutAttemptActionRef].includes(a.actionRef);
  } catch { return false; }
}
