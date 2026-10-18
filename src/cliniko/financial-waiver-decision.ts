import { KeyObject, verify } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { financialIntentDigest } from "./financial-booking-observation.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";

/** A positive, independently issued decision only. No absent-waiver, paid,
 * collection, refund, clinical-effect or restoration authority is encoded. */
export type FinancialWaiverDecision = Readonly<{
  actionRef: string; financialActionRef: string; intentRecallRef: string; intentDigest: string; targetRef: string;
  amount: number; currency: string; approvedAt: string; expiresAt: string; issuerKeyRef: string;
}>;
export type FinancialWaiverExpected = Readonly<{ intent: ClinikoFinancialIntent; intentRecallRef: string; targetRef: string }>;
export type FinancialWaiverIssuerKey = Readonly<{ keyRef: string; publicKey: KeyObject }>;
type Failure = Readonly<{ kind: "invalidWaiverDecision" }>;
const header = "Abby approved financial waiver v1";
const instruction = "Waiver decision only. No payment, refund or clinical action authorized.";
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const invalid = (): Result<never, Failure> => err({ kind: "invalidWaiverDecision" });

export function financialWaiverPayload(value: FinancialWaiverDecision): string | undefined {
  try {
    if (!value || Object.keys(value).sort().join(",") !== "actionRef,amount,approvedAt,currency,expiresAt,financialActionRef,intentDigest,intentRecallRef,issuerKeyRef,targetRef" ||
        !validRecallMarker(value.actionRef) || !validRecallMarker(value.financialActionRef) || value.actionRef === value.financialActionRef ||
        !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(value.intentRecallRef) || !/^[a-f0-9]{64}$/.test(value.intentDigest) ||
        !/^cliniko:(?:appointment|attendee):[1-9][0-9]{0,18}$/.test(value.targetRef) || !Number.isSafeInteger(value.amount) || value.amount < 1 || value.amount > 99_999_999 ||
        typeof value.currency !== "string" || !/^[a-z]{3}$/.test(value.currency) || !instant(value.approvedAt) || !instant(value.expiresAt) || value.expiresAt <= value.approvedAt ||
        typeof value.issuerKeyRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.issuerKeyRef)) return undefined;
    return JSON.stringify([value.actionRef, value.financialActionRef, value.intentRecallRef, value.intentDigest, value.targetRef,
      value.amount, value.currency, value.approvedAt, value.expiresAt, value.issuerKeyRef]);
  } catch { return undefined; }
}
export function financialWaiverMessage(payload: string): Buffer { return Buffer.from(`${header}\n${payload}\n${instruction}`, "utf8"); }
export function formatFinancialWaiverDecision(value: FinancialWaiverDecision, signature: string): string | undefined {
  const payload = financialWaiverPayload(value);
  if (!payload || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature) || Buffer.from(signature, "base64url").toString("base64url") !== signature) return undefined;
  const summary = `${header}\n${payload}\n${signature}\n${instruction}`;
  return validRecallSummary(summary) ? formatRecallNote(value.actionRef, summary) : undefined;
}
/** Trust is supplied independently, not selected by the note's claimed key.
 * A valid signature is still not current issuer approval or native retention. */
export function verifyFinancialWaiverDecision(notes: unknown, expected: FinancialWaiverExpected, issuer: FinancialWaiverIssuerKey,
  now: string): Result<FinancialWaiverDecision, Failure> {
  try {
    if (typeof notes !== "string" || notes.length > 1_050 || !instant(now) || !(issuer.publicKey instanceof KeyObject) ||
        issuer.publicKey.type !== "public" || issuer.publicKey.asymmetricKeyType !== "ed25519") return invalid();
    const lines = notes.split("\n");
    if (lines.length !== 5 || lines[1] !== header || lines[4] !== instruction) return invalid();
    const f: unknown = JSON.parse(lines[2]!);
    if (!Array.isArray(f) || f.length !== 10 || !f.every((value, index) => index === 5 ? typeof value === "number" : typeof value === "string")) return invalid();
    const value: FinancialWaiverDecision = { actionRef: f[0], financialActionRef: f[1], intentRecallRef: f[2], intentDigest: f[3], targetRef: f[4],
      amount: f[5], currency: f[6], approvedAt: f[7], expiresAt: f[8], issuerKeyRef: f[9] };
    if (formatFinancialWaiverDecision(value, lines[3]!) !== notes || value.issuerKeyRef !== issuer.keyRef ||
        !verify(null, financialWaiverMessage(lines[2]!), issuer.publicKey, Buffer.from(lines[3]!, "base64url"))) return invalid();
    const intent = expected.intent;
    if (value.financialActionRef !== intent.actionRef || value.intentRecallRef !== expected.intentRecallRef || value.intentDigest !== financialIntentDigest(intent) ||
        value.targetRef !== expected.targetRef || !value.targetRef.startsWith(intent.booking.kind === "book" ? "cliniko:appointment:" : "cliniko:attendee:") ||
        value.amount > intent.payment.amount || value.currency !== intent.payment.currency || value.approvedAt < intent.createdAt || value.approvedAt > now || value.expiresAt <= now ||
        [intent.actionRef, intent.booking.actionRef, ...Object.values(intent.effects)].includes(value.actionRef)) return invalid();
    return ok(Object.freeze(value));
  } catch { return invalid(); }
}
