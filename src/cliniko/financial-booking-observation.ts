import { createHash, KeyObject, verify } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { encodeClinikoFinancialIntent } from "./financial-review-intent.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";

/** Authenticated producer observation, NOT current financial permission, money,
 * durable retention, immutable provider history, or permission to repeat a POST. */
export type FinancialBookingConsent = Readonly<{ presentationRef: string; presentationDigest: string; playedAt: string; acceptedAt: string; acceptanceRef: string }>;
export type ClinikoFinancialBookingObservation = Readonly<{
  actionRef: string; financialActionRef: string; intentRecallRef: string; intentDigest: string;
  bookingActionRef: string; targetRef: string; observedAt: string; producerKeyRef: string; financialConsent?: FinancialBookingConsent;
}>;
type Failure = Readonly<{ kind: "invalidBookingObservation" }>;
const header = "Abby financial booking observation v1";
const consentHeader = "Abby financial booking observation v2";
const instruction = "Producer observation only. No collection or clinical action authorized.";
const invalid = (): Result<never, Failure> => err({ kind: "invalidBookingObservation" });
const instant = (v: unknown): v is string => typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

export function financialIntentDigest(intent: ClinikoFinancialIntent): string | undefined {
  const encoded = encodeClinikoFinancialIntent(intent);
  return encoded.ok ? createHash("sha256").update(encoded.value, "utf8").digest("hex") : undefined;
}

/** Internal producer representation; signing this requires the booking owner's
 * trusted private key. No unsigned note decoder promotes a claimed receipt. */
export function financialBookingObservationPayload(value: ClinikoFinancialBookingObservation): string | undefined {
  const consent = value?.financialConsent;
  if (!value || Object.keys(value).sort().join(",") !==
      (consent === undefined ? "actionRef,bookingActionRef,financialActionRef,intentDigest,intentRecallRef,observedAt,producerKeyRef,targetRef" :
        "actionRef,bookingActionRef,financialActionRef,financialConsent,intentDigest,intentRecallRef,observedAt,producerKeyRef,targetRef") ||
      ![value.actionRef, value.financialActionRef, value.bookingActionRef].every(validRecallMarker) ||
      new Set([value.actionRef, value.financialActionRef, value.bookingActionRef]).size !== 3 ||
      !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(value.intentRecallRef) ||
      !/^[a-f0-9]{64}$/.test(value.intentDigest) ||
      !/^cliniko:(?:appointment|attendee):[1-9][0-9]{0,18}$/.test(value.targetRef) ||
      !instant(value.observedAt) || typeof value.producerKeyRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.producerKeyRef)) return undefined;
  if (consent !== undefined && (!consent || Object.keys(consent).sort().join(",") !== "acceptanceRef,acceptedAt,playedAt,presentationDigest,presentationRef" ||
      !validRecallMarker(consent.presentationRef) || !validRecallMarker(consent.acceptanceRef) ||
      new Set([value.actionRef, value.financialActionRef, value.bookingActionRef, consent.presentationRef, consent.acceptanceRef]).size !== 5 ||
      typeof consent.presentationDigest !== "string" || !/^[a-f0-9]{64}$/.test(consent.presentationDigest) ||
      !instant(consent.playedAt) || !instant(consent.acceptedAt) || consent.acceptedAt < consent.playedAt || consent.acceptedAt > value.observedAt)) return undefined;
  return JSON.stringify([value.actionRef, value.financialActionRef, value.intentRecallRef, value.intentDigest,
    value.bookingActionRef, value.targetRef, value.observedAt, value.producerKeyRef,
    ...(consent ? [[consent.presentationRef, consent.presentationDigest, consent.playedAt, consent.acceptedAt, consent.acceptanceRef]] : [])]);
}

/** Domain-separated bytes. The native recall marker is inside the signature. */
export function financialBookingObservationMessage(payload: string, version: 1 | 2 = 1): Buffer {
  return Buffer.from(`${version === 2 ? consentHeader : header}\n${payload}\n${instruction}`, "utf8");
}

export function formatFinancialBookingObservation(value: ClinikoFinancialBookingObservation, signature: string): string | undefined {
  const payload = financialBookingObservationPayload(value);
  if (!payload || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
      Buffer.from(signature, "base64url").toString("base64url") !== signature) return undefined;
  const summary = `${value.financialConsent ? consentHeader : header}\n${payload}\n${signature}\n${instruction}`;
  return validRecallSummary(summary) ? formatRecallNote(value.actionRef, summary) : undefined;
}

/** Authenticates only an unscoped producer citation. Its source/digest must still
 * be bound to independently authorized native intent context before use. A key
 * reference from notes never supplies trust, ownership or current permission. */
export function authenticateFinancialBookingCitation(notes: unknown, trust: Readonly<{
  producerKeyRef: string; publicKey: KeyObject;
}>): Result<ClinikoFinancialBookingObservation, Failure> {
  try {
    if (typeof notes !== "string" || notes.length > 1_050 || !(trust.publicKey instanceof KeyObject) ||
        trust.publicKey.type !== "public" || trust.publicKey.asymmetricKeyType !== "ed25519") return invalid();
    const lines = notes.split("\n");
    if (lines.length !== 5 || (lines[1] !== header && lines[1] !== consentHeader) || lines[4] !== instruction) return invalid();
    const fields: unknown = JSON.parse(lines[2]!);
    const version = lines[1] === consentHeader ? 2 : 1;
    if (!Array.isArray(fields) || fields.length !== (version === 2 ? 9 : 8) || !fields.slice(0, 8).every(f => typeof f === "string") ||
        version === 2 && (!Array.isArray(fields[8]) || fields[8].length !== 5 || !fields[8].every(f => typeof f === "string"))) return invalid();
    const value: ClinikoFinancialBookingObservation = {
      actionRef: fields[0]!, financialActionRef: fields[1]!, intentRecallRef: fields[2]!, intentDigest: fields[3]!,
      bookingActionRef: fields[4]!, targetRef: fields[5]!, observedAt: fields[6]!, producerKeyRef: fields[7]!,
      ...(version === 2 ? { financialConsent: { presentationRef: fields[8][0], presentationDigest: fields[8][1], playedAt: fields[8][2], acceptedAt: fields[8][3], acceptanceRef: fields[8][4] } } : {}),
    };
    if (formatFinancialBookingObservation(value, lines[3]!) !== notes || value.producerKeyRef !== trust.producerKeyRef ||
        !verify(null, financialBookingObservationMessage(lines[2]!, version), trust.publicKey, Buffer.from(lines[3]!, "base64url"))) return invalid();
    return ok(Object.freeze(value));
  } catch { return invalid(); }
}

/** The trusted owner supplies current producer trust and exact expected private
 * intent/record. Successful verification authenticates only that observation;
 * it does not grant ownership, current financial permission or an effect. */
export function verifyFinancialBookingObservation(notes: unknown, expected: Readonly<{
  intent: ClinikoFinancialIntent; intentRecallRef: string; producerKeyRef: string; publicKey: KeyObject;
}>): Result<ClinikoFinancialBookingObservation, Failure> {
  try {
    const authenticated = authenticateFinancialBookingCitation(notes, expected);
    if (!authenticated.ok) return invalid();
    const value = authenticated.value;
    if (value.financialActionRef !== expected.intent.actionRef || value.intentRecallRef !== expected.intentRecallRef ||
        value.intentDigest !== financialIntentDigest(expected.intent) || value.bookingActionRef !== expected.intent.booking.actionRef ||
        (value.financialConsent !== undefined && (value.financialConsent.playedAt < expected.intent.createdAt ||
          [value.financialConsent.presentationRef, value.financialConsent.acceptanceRef].some(id => Object.values(expected.intent.effects).includes(id)))) ||
        value.observedAt < expected.intent.createdAt || Object.values(expected.intent.effects).includes(value.actionRef) ||
        !value.targetRef.startsWith(expected.intent.booking.kind === "book" ? "cliniko:appointment:" : "cliniko:attendee:")) return invalid();
    return authenticated;
  } catch { return invalid(); }
}
