import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { formatRecallNote, validRecallDate, validRecallMarker, validRecallSummary } from "./recall-note.ts";

type Interval = Readonly<{ startsAt: string; endsAt: string }>;
type Selection = Readonly<{ practitionerId: string; appointmentTypeId: string }>;
export type ClinikoReviewOperation =
  | Readonly<{ kind: "book" }> & Interval & Selection
  | Readonly<{ kind: "cancel"; appointmentId: string }> & Interval & Selection
  | Readonly<{ kind: "reschedule"; appointmentId: string; newStartsAt: string; newEndsAt: string }> & Interval & Selection;

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
const header = "Abby appointment review v1";
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
  if (!row || !id(row.practitionerId) || !id(row.appointmentTypeId) || !interval(row, "startsAt", "endsAt")) return false;
  const common = ["kind", "practitionerId", "appointmentTypeId", "startsAt", "endsAt"];
  switch (row.kind) {
    case "book": return keys(row, common);
    case "cancel": return keys(row, [...common, "appointmentId"]) && id(row.appointmentId);
    case "reschedule": return keys(row, [...common, "appointmentId", "newStartsAt", "newEndsAt"]) &&
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
  const summary = `${header}\n${JSON.stringify(request)}\n${instruction}`;
  return validRecallSummary(summary) ? ok(formatRecallNote(marker, summary)) : err({ kind: "invalidReviewRequest" });
}

/** Provider notes are untrusted review context. Parsing must never authorize a mutation. */
export function decodeClinikoReview(notes: unknown): Result<ClinikoDecodedReview, ClinikoReviewRequestFailure> {
  if (typeof notes !== "string") return err({ kind: "invalidReviewRequest" });
  const parts = notes.split("\n");
  if (parts.length !== 4 || !parts[0]?.startsWith("Abby request ") || parts[1] !== header ||
      parts[3] !== instruction || !validRecallSummary(parts.slice(1).join("\n"))) {
    return err({ kind: "invalidReviewRequest" });
  }
  const marker = parts[0].slice("Abby request ".length);
  if (!validRecallMarker(marker)) return err({ kind: "invalidReviewRequest" });
  let request: unknown;
  try { request = JSON.parse(parts[2]!); } catch { return err({ kind: "invalidReviewRequest" }); }
  return validRequest(request) ? ok({ marker, request }) : err({ kind: "invalidReviewRequest" });
}
