import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";

type Selection = Readonly<{
  actionRef: string; practitionerId: string; appointmentTypeId: string;
  startsAt: string; endsAt: string;
}>;
/** Private Cliniko-owned prospective context, never a booking receipt or send permit.
 * No field in this record belongs in standalone Abby's local effect journal.
 * Recipient and terms require independent clinic approval and fresh revalidation. */
export type ClinikoFinancialIntent = Readonly<{
  actionRef: string;
  scope: LocationScope;
  patientId: string;
  businessId: string;
  credentialFingerprint: string;
  booking: Selection & (
    | Readonly<{ kind: "book" }>
    | Readonly<{ kind: "classBook"; sessionId: string }>
  );
  stripe: Readonly<{ accountRef: string; livemode: boolean }>;
  payment: Readonly<{
    amount: number; currency: string; policyVersion: string; termsVersion: string; deadline: string;
  }>;
  recipient: Readonly<{ kind: "email"; address: string }>;
  effects: Readonly<{ checkout: string; linkDelivery: string; receiptDelivery: string; expiry: string }>;
  createdAt: string;
}>;
type Failure = Readonly<{ kind: "invalidFinancialIntent" }>;
const header = "Abby financial intent v1";
const instruction = "Private context only. No collection or clinical action authorized.";
const invalid = (): Result<never, Failure> => err({ kind: "invalidFinancialIntent" });
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function exact(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
}
function nativeId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
}
function reference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function valid(value: unknown): value is ClinikoFinancialIntent {
  const row = record(value), scope = record(row?.scope), booking = record(row?.booking),
    stripe = record(row?.stripe), payment = record(row?.payment), recipient = record(row?.recipient), effects = record(row?.effects);
  if (!row || !scope || !booking || !stripe || !payment || !recipient || !effects ||
      !exact(row, ["actionRef", "scope", "patientId", "businessId", "credentialFingerprint", "booking", "stripe", "payment", "recipient", "effects", "createdAt"]) ||
      !exact(scope, ["tenantId", "clinicId", "locationId"]) || !Object.values(scope).every(reference) ||
      !nativeId(row.patientId) || !nativeId(row.businessId) || typeof row.credentialFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.credentialFingerprint) || !instant(row.createdAt) ||
      !["book", "classBook"].includes(String(booking.kind)) ||
      !exact(booking, ["kind", "actionRef", "practitionerId", "appointmentTypeId", "startsAt", "endsAt", ...(booking.kind === "classBook" ? ["sessionId"] : [])]) ||
      !nativeId(booking.practitionerId) || !nativeId(booking.appointmentTypeId) ||
      (booking.kind === "classBook" && !nativeId(booking.sessionId)) || !instant(booking.startsAt) || !instant(booking.endsAt) ||
      booking.startsAt >= booking.endsAt ||
      !exact(stripe, ["accountRef", "livemode"]) || typeof stripe.accountRef !== "string" ||
      !/^acct_[A-Za-z0-9]{1,128}$/.test(stripe.accountRef) || typeof stripe.livemode !== "boolean" ||
      !exact(payment, ["amount", "currency", "policyVersion", "termsVersion", "deadline"]) ||
      !Number.isSafeInteger(payment.amount) || Number(payment.amount) < 1 || Number(payment.amount) > 99_999_999 ||
      typeof payment.currency !== "string" || !/^[a-z]{3}$/.test(payment.currency) ||
      !reference(payment.policyVersion) || !reference(payment.termsVersion) || !instant(payment.deadline) ||
      payment.deadline <= row.createdAt ||
      !exact(recipient, ["kind", "address"]) || recipient.kind !== "email" || typeof recipient.address !== "string" ||
      recipient.address.length > 254 || !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(recipient.address) ||
      !exact(effects, ["checkout", "linkDelivery", "receiptDelivery", "expiry"])) return false;
  const ids = [row.actionRef, booking.actionRef, ...Object.values(effects)];
  return ids.every(validRecallMarker) && new Set(ids).size === ids.length;
}

/** Bounded, deterministic uncompressed representation for a dedicated financial
 * recall type. Oversize refuses; no truncation, transcript, arbitrary note or
 * financial status is accepted. The action ID is the native recall marker. */
export function encodeClinikoFinancialIntent(intent: ClinikoFinancialIntent): Result<string, Failure> {
  if (!valid(intent)) return invalid();
  const { scope: s, booking: b, stripe: a, payment: p, effects: e } = intent;
  const payload = [
    [s.tenantId, s.clinicId, s.locationId], intent.patientId, intent.businessId, intent.credentialFingerprint,
    [b.kind, b.actionRef, b.practitionerId, b.appointmentTypeId, b.startsAt, b.endsAt, ...(b.kind === "classBook" ? [b.sessionId] : [])],
    [a.accountRef, a.livemode], [p.amount, p.currency, p.policyVersion, p.termsVersion, p.deadline],
    intent.recipient.address, [e.checkout, e.linkDelivery, e.receiptDelivery, e.expiry], intent.createdAt,
  ];
  const summary = `${header}\n${JSON.stringify(payload)}\n${instruction}`;
  return validRecallSummary(summary) ? ok(formatRecallNote(intent.actionRef, summary)) : invalid();
}

/** Provider notes are untrusted. Decoding preserves context only; it proves no
 * ownership, permission, immutable history, booking acknowledgement or money. */
export function decodeClinikoFinancialIntent(notes: unknown): Result<ClinikoFinancialIntent, Failure> {
  if (typeof notes !== "string" || notes.length > 1_050) return invalid();
  const lines = notes.split("\n");
  if (lines.length !== 4 || lines[1] !== header || lines[3] !== instruction ||
      !lines[0]!.startsWith("Abby request ") || !validRecallSummary(lines.slice(1).join("\n"))) return invalid();
  const actionRef = lines[0]!.slice("Abby request ".length);
  let value: unknown;
  try { value = JSON.parse(lines[2]!); } catch { return invalid(); }
  const array = (v: unknown, n: number): v is unknown[] => Array.isArray(v) && v.length === n;
  if (!array(value, 10) || !array(value[0], 3) ||
      !(array(value[4], 6) || array(value[4], 7)) || !array(value[5], 2) ||
      !array(value[6], 5) || !array(value[8], 4)) return invalid();
  const [s, patientId, businessId, credentialFingerprint, b, a, p, address, e, createdAt] = value;
  const scope = s as unknown[], booking = b as unknown[], stripe = a as unknown[], payment = p as unknown[], effects = e as unknown[];
  const intent: unknown = {
    actionRef, scope: { tenantId: scope[0], clinicId: scope[1], locationId: scope[2] }, patientId, businessId, credentialFingerprint,
    booking: { kind: booking[0], actionRef: booking[1], practitionerId: booking[2], appointmentTypeId: booking[3], startsAt: booking[4], endsAt: booking[5],
      ...(booking.length === 7 ? { sessionId: booking[6] } : {}) },
    stripe: { accountRef: stripe[0], livemode: stripe[1] },
    payment: { amount: payment[0], currency: payment[1], policyVersion: payment[2], termsVersion: payment[3], deadline: payment[4] },
    recipient: { kind: "email", address },
    effects: { checkout: effects[0], linkDelivery: effects[1], receiptDelivery: effects[2], expiry: effects[3] }, createdAt,
  };
  if (!valid(intent)) return invalid();
  const canonical = encodeClinikoFinancialIntent(intent);
  return canonical.ok && canonical.value === notes ? ok(intent) : invalid();
}
