import { createHash, KeyObject, verify } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { encodeClinikoFinancialIntent } from "./financial-review-intent.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";

/** Authenticated producer observation, NOT current financial permission, money,
 * durable retention, immutable provider history, or permission to repeat a POST. */
export type ClinikoFinancialBookingObservation = Readonly<{
  actionRef: string; financialActionRef: string; intentRecallRef: string; intentDigest: string;
  bookingActionRef: string; targetRef: string; observedAt: string; producerKeyRef: string;
}>;
type Failure = Readonly<{ kind: "invalidBookingObservation" }>;
const header = "Abby financial booking observation v1";
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
  if (!value || Object.keys(value).sort().join(",") !==
      "actionRef,bookingActionRef,financialActionRef,intentDigest,intentRecallRef,observedAt,producerKeyRef,targetRef" ||
      ![value.actionRef, value.financialActionRef, value.bookingActionRef].every(validRecallMarker) ||
      new Set([value.actionRef, value.financialActionRef, value.bookingActionRef]).size !== 3 ||
      !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(value.intentRecallRef) ||
      !/^[a-f0-9]{64}$/.test(value.intentDigest) ||
      !/^cliniko:(?:appointment|attendee):[1-9][0-9]{0,18}$/.test(value.targetRef) ||
      !instant(value.observedAt) || typeof value.producerKeyRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.producerKeyRef)) return undefined;
  return JSON.stringify([value.actionRef, value.financialActionRef, value.intentRecallRef, value.intentDigest,
    value.bookingActionRef, value.targetRef, value.observedAt, value.producerKeyRef]);
}

/** Domain-separated bytes. The native recall marker is inside the signature. */
export function financialBookingObservationMessage(payload: string): Buffer {
  return Buffer.from(`${header}\n${payload}\n${instruction}`, "utf8");
}

export function formatFinancialBookingObservation(value: ClinikoFinancialBookingObservation, signature: string): string | undefined {
  const payload = financialBookingObservationPayload(value);
  if (!payload || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
      Buffer.from(signature, "base64url").toString("base64url") !== signature) return undefined;
  const summary = `${header}\n${payload}\n${signature}\n${instruction}`;
  return validRecallSummary(summary) ? formatRecallNote(value.actionRef, summary) : undefined;
}

/** The trusted financial owner supplies the CURRENT approved producer public key
 * and exact expected private intent/record. A key taken from notes is not trust.
 * Successful verification authenticates only what that producer observed. */
export function verifyFinancialBookingObservation(notes: unknown, expected: Readonly<{
  intent: ClinikoFinancialIntent; intentRecallRef: string; producerKeyRef: string; publicKey: KeyObject;
}>): Result<ClinikoFinancialBookingObservation, Failure> {
  try {
    if (typeof notes !== "string" || notes.length > 1_050 || !(expected.publicKey instanceof KeyObject) ||
        expected.publicKey.type !== "public" || expected.publicKey.asymmetricKeyType !== "ed25519") return invalid();
    const lines = notes.split("\n");
    if (lines.length !== 5 || lines[1] !== header || lines[4] !== instruction) return invalid();
    const fields: unknown = JSON.parse(lines[2]!);
    if (!Array.isArray(fields) || fields.length !== 8 || !fields.every(f => typeof f === "string")) return invalid();
    const value: ClinikoFinancialBookingObservation = {
      actionRef: fields[0]!, financialActionRef: fields[1]!, intentRecallRef: fields[2]!, intentDigest: fields[3]!,
      bookingActionRef: fields[4]!, targetRef: fields[5]!, observedAt: fields[6]!, producerKeyRef: fields[7]!,
    };
    if (formatFinancialBookingObservation(value, lines[3]!) !== notes ||
        value.financialActionRef !== expected.intent.actionRef || value.intentRecallRef !== expected.intentRecallRef ||
        value.intentDigest !== financialIntentDigest(expected.intent) || value.bookingActionRef !== expected.intent.booking.actionRef ||
        value.producerKeyRef !== expected.producerKeyRef || value.observedAt < expected.intent.createdAt ||
        !value.targetRef.startsWith(expected.intent.booking.kind === "book" ? "cliniko:appointment:" : "cliniko:attendee:") ||
        !verify(null, financialBookingObservationMessage(lines[2]!), expected.publicKey, Buffer.from(lines[3]!, "base64url"))) return invalid();
    return ok(Object.freeze(value));
  } catch { return invalid(); }
}
