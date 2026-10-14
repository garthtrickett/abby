import { err, ok } from "../core/model.ts";
import type { ConfirmationContentKind } from "../standalone/smtp-appointment-confirmation-delivery.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { ClinikoCancellationRequest } from "./appointment-write.ts";
import { formatRecallNote, validRecallDate, validRecallMarker, validRecallSummary } from "./recall-note.ts";

type Interval = Readonly<{ startsAt: string; endsAt: string }>;
type Selection = Readonly<{ practitionerId: string; appointmentTypeId: string }>;
export type ClinikoReviewOperation =
  | Readonly<{ kind: "classBook"; sessionId: string; attendanceActionId: string }> & Interval & Selection
  | Readonly<{ kind: "classCancel"; sessionId: string; attendeeId: string; cancellationReason: ClinikoCancellationRequest["cancellationReason"] }> & Interval & Selection
  | Readonly<{ kind: "book" }> & Interval & Selection
  | Readonly<{ kind: "cancel"; appointmentId: string; cancellationReason: ClinikoCancellationRequest["cancellationReason"] }> & Interval & Selection
  | Readonly<{ kind: "reschedule"; appointmentId: string; newStartsAt: string; newEndsAt: string; newPractitionerId?: string }> & Interval & Selection
  | Readonly<{ kind: "patientUpdate"; correctionRef: string }>
  | Readonly<{ kind: "confirmationResend"; resendRef: string; appointmentId: string; contentKind?: ConfirmationContentKind }> & Interval & Selection;

/** Provider-owned confirmed context, including patient-link binding. Never a send permit. */
export type ClinikoReviewRequest = Readonly<{
  scope: LocationScope;
  patientId: string;
  businessId: string;
  credentialFingerprint: string;
  policyVersion: string;
  termsVersion: string;
  timeZone: string;
  createdAt: string;
  operation: ClinikoReviewOperation;
}>;
export type ClinikoReviewRequestFailure = Readonly<{ kind: "invalidReviewRequest" }>;
export type ClinikoDecodedReview = Readonly<{ marker: string; request: ClinikoReviewRequest }>;
const header = "Abby appointment review v2";
const correctionHeader = "Abby patient correction review v1";
const resendHeader = "Abby confirmation resend review v1";
const resendContentHeader = "Abby confirmation resend review v2";
const reviewHeader = (operation: ClinikoReviewOperation) => operation.kind === "classBook" || operation.kind === "classCancel" ? classHeader : operation.kind === "patientUpdate" ? correctionHeader : operation.kind === "confirmationResend" ?
  operation.contentKind ? resendContentHeader : resendHeader : header;
const classHeader = "Abby class attendance review v1";
const instruction = "Staff review required. Do not replay automatically.";
const idPattern = /^[1-9][0-9]{0,18}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...names].sort().join(",");
}
function reference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
function id(value: unknown): value is string { return typeof value === "string" && idPattern.test(value); }
function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
      !validRecallDate(value.slice(0, 10))) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).getUTCHours() === Number(value.slice(11, 13))
    ? parsed : undefined;
}
function interval(value: Record<string, unknown>, start: string, end: string): boolean {
  const from = instant(value[start]), to = instant(value[end]);
  return from !== undefined && to !== undefined && from < to;
}
function operation(value: unknown): value is ClinikoReviewOperation {
  const row = record(value);
  if (row?.kind === "patientUpdate") return keys(row, ["kind", "correctionRef"]) && typeof row.correctionRef === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(row.correctionRef);
  if (!row || !id(row.practitionerId) || !id(row.appointmentTypeId) || !interval(row, "startsAt", "endsAt")) return false;
  const common = ["kind", "practitionerId", "appointmentTypeId", "startsAt", "endsAt"];
  switch (row.kind) {
    case "classBook": return keys(row, [...common, "sessionId", "attendanceActionId"]) && id(row.sessionId) &&
      typeof row.attendanceActionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.attendanceActionId);
    case "classCancel": return keys(row, [...common, "sessionId", "attendeeId", "cancellationReason"]) && id(row.sessionId) && id(row.attendeeId) &&
      typeof row.cancellationReason === "number" && [10, 20, 30, 40, 50, 60].includes(row.cancellationReason);
    case "confirmationResend": return keys(row, [...common, "appointmentId", "resendRef", ...(Object.hasOwn(row, "contentKind") ? ["contentKind"] : [])]) && (!Object.hasOwn(row, "contentKind") || typeof row.contentKind === "string" && ["activeInPerson", "activeTelehealth", "cancelled"].includes(row.contentKind)) && id(row.appointmentId) &&
      typeof row.resendRef === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.resendRef);
    case "book": return keys(row, common);
    case "cancel": return keys(row, [...common, "appointmentId", "cancellationReason"]) && id(row.appointmentId) &&
      typeof row.cancellationReason === "number" && [10, 20, 30, 40, 50, 60].includes(row.cancellationReason);
    case "reschedule": return keys(row, [...common, "appointmentId", "newStartsAt", "newEndsAt", ...(Object.hasOwn(row, "newPractitionerId") ? ["newPractitionerId"] : [])]) &&
      (!Object.hasOwn(row, "newPractitionerId") || id(row.newPractitionerId) && row.newPractitionerId !== row.practitionerId) &&
      id(row.appointmentId) && interval(row, "newStartsAt", "newEndsAt");
    default: return false;
  }
}
function validRequest(value: unknown): value is ClinikoReviewRequest {
  const row = record(value), scope = record(row?.scope);
  if (!row || !scope || !keys(row, ["scope", "patientId", "businessId", "credentialFingerprint", "policyVersion",
      "termsVersion", "timeZone", "createdAt", "operation"]) ||
      !keys(scope, ["tenantId", "clinicId", "locationId"]) ||
      ![scope.tenantId, scope.clinicId, scope.locationId, row.policyVersion, row.termsVersion].every(reference) ||
      !id(row.patientId) || !id(row.businessId) || typeof row.credentialFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.credentialFingerprint) || instant(row.createdAt) === undefined ||
      !operation(row.operation) || typeof row.timeZone !== "string" || row.timeZone.length > 128) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: row.timeZone }); return true; } catch { return false; }
}

/** This bounded protocol fits the existing recall writer. No transcript or free-text field is accepted. */
export function encodeClinikoReview(marker: string, request: ClinikoReviewRequest): Result<string, ClinikoReviewRequestFailure> {
  if (!validRecallMarker(marker) || !validRequest(request)) return err({ kind: "invalidReviewRequest" });
  const summary = `${reviewHeader(request.operation)}\n${JSON.stringify(request)}\n${instruction}`;
  return validRecallSummary(summary) ? ok(formatRecallNote(marker, summary)) : err({ kind: "invalidReviewRequest" });
}

/** Provider notes are untrusted review context. Parsing must never authorize a mutation. */
export function decodeClinikoReview(notes: unknown): Result<ClinikoDecodedReview, ClinikoReviewRequestFailure> {
  if (typeof notes !== "string") return err({ kind: "invalidReviewRequest" });
  const parts = notes.split("\n");
  if (parts.length !== 4 || !parts[0]?.startsWith("Abby request ") || ![header, correctionHeader, resendHeader, resendContentHeader, classHeader].includes(parts[1]!) ||
      parts[3] !== instruction || !validRecallSummary(parts.slice(1).join("\n"))) {
    return err({ kind: "invalidReviewRequest" });
  }
  const marker = parts[0].slice("Abby request ".length);
  if (!validRecallMarker(marker)) return err({ kind: "invalidReviewRequest" });
  let request: unknown;
  try { request = JSON.parse(parts[2]!); } catch { return err({ kind: "invalidReviewRequest" }); }
  return validRequest(request) && parts[1] === reviewHeader(request.operation)
    ? ok({ marker, request }) : err({ kind: "invalidReviewRequest" });
}
