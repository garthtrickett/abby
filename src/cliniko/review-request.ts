import { err, ok } from "../core/model.ts";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { ConfirmationContentKind } from "../standalone/smtp-appointment-confirmation-delivery.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { ClinikoCancellationRequest } from "./appointment-write.ts";
import { formatRecallNote, validRecallDate, validRecallMarker, validRecallSummary } from "./recall-note.ts";

type Interval = Readonly<{ startsAt: string; endsAt: string }>;
type Selection = Readonly<{ practitionerId: string; appointmentTypeId: string }>;
type ClassPass = Readonly<{ patientCaseId: string; entitlementRef: string; usageFingerprint: string; maximum: number; used: number }>;
type ClassCancellationPass = ClassPass & Readonly<{ effect: "releaseOne" | "unchanged" | "consumeOne" }>;
export type ClassMovementPass = Readonly<{ source: ClassCancellationPass; destination: ClassPass; stagingContractVersion: string }>;
export type ClinikoReviewOperation =
  | Readonly<{ kind: "classMove"; sessionId: string; attendeeId: string; newSessionId: string; newStartsAt: string; newEndsAt: string;
      newPractitionerId?: string; newAppointmentTypeId?: string; attendanceActionId: string;
      cancellationReason: ClinikoCancellationRequest["cancellationReason"]; compensation: "cancelReplacementIfOriginalUnsent"; pass?: ClassMovementPass; quotaStaging?: string }> & Interval & Selection
  | Readonly<{ kind: "classBook"; sessionId: string; attendanceActionId: string; pass?: ClassPass }> & Interval & Selection
  | Readonly<{ kind: "classCancel"; sessionId: string; attendeeId: string; cancellationReason: ClinikoCancellationRequest["cancellationReason"]; pass?: ClassCancellationPass }> & Interval & Selection
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
const reviewHeader = (operation: ClinikoReviewOperation) => operation.kind === "classMove" ? operation.pass ? operation.quotaStaging ? stagedClassPassMoveHeader : classPassMoveHeader : classMoveHeader : operation.kind === "classCancel" && operation.pass ? classPassCancellationHeader : operation.kind === "classBook" && operation.pass ? classPassHeader : operation.kind === "classBook" || operation.kind === "classCancel" ? classHeader : operation.kind === "patientUpdate" ? correctionHeader : operation.kind === "confirmationResend" ?
  operation.contentKind ? resendContentHeader : resendHeader : header;
const classMoveHeader = "Abby class movement review v1";
const classPassMoveHeader = "Abby class pass movement review v1";
const stagedClassPassMoveHeader = "Abby staged class pass movement review v1";
const classHeader = "Abby class attendance review v1";
const classPassHeader = "Abby class attendance review v2";
const classPassCancellationHeader = "Abby class cancellation pass review v1";
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
function classPass(value: unknown): value is ClassPass {
  const row = record(value);
  return !!row && keys(row, ["patientCaseId", "entitlementRef", "usageFingerprint", "maximum", "used"]) && id(row.patientCaseId) &&
    typeof row.entitlementRef === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.entitlementRef) &&
    typeof row.usageFingerprint === "string" && /^[a-f0-9]{64}$/.test(row.usageFingerprint) && Number.isSafeInteger(row.maximum) &&
    Number(row.maximum) >= 1 && Number(row.maximum) <= 300 && Number.isSafeInteger(row.used) && Number(row.used) >= 0 && Number(row.used) < Number(row.maximum);
}
function classCancellationPass(value: unknown): value is ClassCancellationPass {
  const row = record(value);
  if (!row || !keys(row, ["patientCaseId", "entitlementRef", "usageFingerprint", "maximum", "used", "effect"]) || !id(row.patientCaseId) ||
    typeof row.entitlementRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.entitlementRef) ||
    typeof row.usageFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.usageFingerprint) || !Number.isSafeInteger(row.maximum) ||
    Number(row.maximum) < 1 || Number(row.maximum) > 300 || !Number.isSafeInteger(row.used) || Number(row.used) < 0 || Number(row.used) > 1000) return false;
  return row.effect === "releaseOne" && Number(row.used) >= 1 || row.effect === "unchanged" || row.effect === "consumeOne" && Number(row.used) < 1000;
}
function classMovementPass(value: unknown): value is ClassMovementPass {
  const row = record(value), destination = record(row?.destination);
  if (!row || !keys(row, ["source", "destination", "stagingContractVersion"]) || !classCancellationPass(row.source) || !destination ||
    !keys(destination, ["patientCaseId", "entitlementRef", "usageFingerprint", "maximum", "used"]) ||
    !classCancellationPass({ ...destination, effect: "unchanged" }) || typeof row.stagingContractVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.stagingContractVersion)) return false;
  const source = row.source, delta = source.effect === "releaseOne" ? -1 : source.effect === "consumeOne" ? 1 : 0;
  if (source.patientCaseId === destination.patientCaseId) return source.usageFingerprint === destination.usageFingerprint &&
    source.maximum === destination.maximum && source.used === destination.used && source.used + delta + 1 <= source.maximum;
  return Number(destination.used) < Number(destination.maximum) && (delta <= 0 || source.used + delta <= source.maximum);
}
/** A versioned losslessly compressed tuple keeps the complete two-case context
 * within the existing 1,000-character recall summary bound. Nothing is
 * truncated, hashed away or inferred. Legacy review JSON remains unchanged. */
function packPassMove(request: ClinikoReviewRequest): unknown {
  const o = request.operation;
  if (o.kind !== "classMove" || !o.pass) return request;
  const p = o.pass, tuple = (c: ClassPass) => [c.patientCaseId, c.entitlementRef, c.usageFingerprint, c.maximum, c.used];
  return [[request.scope.tenantId, request.scope.clinicId, request.scope.locationId], request.patientId, request.businessId, request.credentialFingerprint,
    request.policyVersion, request.termsVersion, request.timeZone, request.createdAt,
    [o.practitionerId, o.appointmentTypeId, o.startsAt, o.endsAt, o.sessionId, o.attendeeId, o.newSessionId, o.newStartsAt, o.newEndsAt,
      o.newPractitionerId ?? null, o.newAppointmentTypeId ?? null, o.attendanceActionId, o.cancellationReason, o.compensation],
    [[...tuple(p.source), p.source.effect], tuple(p.destination), p.stagingContractVersion], ...(o.quotaStaging ? [o.quotaStaging] : [])];
}
function unpackPassMove(value: unknown): unknown {
  const array = (v: unknown, length: number): v is unknown[] => Array.isArray(v) && v.length === length;
  if ((!array(value, 10) && !array(value, 11)) || !array(value[0], 3) || !array(value[8], 14) || !array(value[9], 3) || !array(value[9][0], 6) || !array(value[9][1], 5)) return undefined;
  const s = value[0], o = value[8], p = value[9], a = p[0] as unknown[], b = p[1] as unknown[];
  const pass = (c: unknown[]) => ({ patientCaseId: c[0], entitlementRef: c[1], usageFingerprint: c[2], maximum: c[3], used: c[4] });
  return { scope: { tenantId: s[0], clinicId: s[1], locationId: s[2] }, patientId: value[1], businessId: value[2], credentialFingerprint: value[3],
    policyVersion: value[4], termsVersion: value[5], timeZone: value[6], createdAt: value[7],
    operation: { kind: "classMove", practitionerId: o[0], appointmentTypeId: o[1], startsAt: o[2], endsAt: o[3], sessionId: o[4], attendeeId: o[5], newSessionId: o[6],
      newStartsAt: o[7], newEndsAt: o[8], ...(o[9] === null ? {} : { newPractitionerId: o[9] }), ...(o[10] === null ? {} : { newAppointmentTypeId: o[10] }),
      attendanceActionId: o[11], cancellationReason: o[12], compensation: o[13], ...(value.length === 11 ? { quotaStaging: value[10] } : {}), pass: { source: { ...pass(a), effect: a[5] }, destination: pass(b), stagingContractVersion: p[2] } } };
}
function operation(value: unknown): value is ClinikoReviewOperation {
  const row = record(value);
  if (row && (("quotaStaging" in row && !Object.hasOwn(row, "quotaStaging")) || ("pass" in row && !Object.hasOwn(row, "pass")))) return false;
  if (row?.kind === "patientUpdate") return keys(row, ["kind", "correctionRef"]) && typeof row.correctionRef === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(row.correctionRef);
  if (!row || !id(row.practitionerId) || !id(row.appointmentTypeId) || !interval(row, "startsAt", "endsAt")) return false;
  const common = ["kind", "practitionerId", "appointmentTypeId", "startsAt", "endsAt"];
  switch (row.kind) {
    case "classMove": return keys(row, [...common, "sessionId", "attendeeId", "newSessionId", "newStartsAt", "newEndsAt", "attendanceActionId", "cancellationReason", "compensation",
      ...(Object.hasOwn(row, "newPractitionerId") ? ["newPractitionerId"] : []), ...(Object.hasOwn(row, "newAppointmentTypeId") ? ["newAppointmentTypeId"] : []),
      ...(Object.hasOwn(row, "pass") ? ["pass"] : []), ...(Object.hasOwn(row, "quotaStaging") ? ["quotaStaging"] : [])]) && (!Object.hasOwn(row, "pass") || classMovementPass(row.pass)) &&
      (!Object.hasOwn(row, "quotaStaging") || !!row.pass && typeof row.quotaStaging === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.quotaStaging)) &&
      id(row.sessionId) && id(row.attendeeId) && id(row.newSessionId) && row.sessionId !== row.newSessionId && interval(row, "newStartsAt", "newEndsAt") &&
      (!Object.hasOwn(row, "newPractitionerId") || id(row.newPractitionerId) && row.newPractitionerId !== row.practitionerId) &&
      (!Object.hasOwn(row, "newAppointmentTypeId") || id(row.newAppointmentTypeId) && row.newAppointmentTypeId !== row.appointmentTypeId) &&
      typeof row.attendanceActionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.attendanceActionId) &&
      typeof row.cancellationReason === "number" && [10, 20, 30, 40, 50, 60].includes(row.cancellationReason) && row.compensation === "cancelReplacementIfOriginalUnsent";
    case "classBook": return keys(row, [...common, "sessionId", "attendanceActionId", ...(Object.hasOwn(row, "pass") ? ["pass"] : [])]) &&
      (!Object.hasOwn(row, "pass") || classPass(row.pass)) && id(row.sessionId) &&
      typeof row.attendanceActionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.attendanceActionId);
    case "classCancel": return keys(row, [...common, "sessionId", "attendeeId", "cancellationReason", ...(Object.hasOwn(row, "pass") ? ["pass"] : [])]) &&
      (!Object.hasOwn(row, "pass") || classCancellationPass(row.pass)) && id(row.sessionId) && id(row.attendeeId) &&
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
  try {
    const json = JSON.stringify(packPassMove(request));
    const bytes = Buffer.from(json);
    if (request.operation.kind === "classMove" && request.operation.pass && bytes.length > 8192) return err({ kind: "invalidReviewRequest" });
    const payload = request.operation.kind === "classMove" && request.operation.pass ? `z1:${deflateRawSync(bytes).toString("base64url")}` : json;
    const summary = `${reviewHeader(request.operation)}\n${payload}\n${instruction}`;
    return validRecallSummary(summary) ? ok(formatRecallNote(marker, summary)) : err({ kind: "invalidReviewRequest" });
  } catch { return err({ kind: "invalidReviewRequest" }); }
}

/** Provider notes are untrusted review context. Parsing must never authorize a mutation. */
export function decodeClinikoReview(notes: unknown): Result<ClinikoDecodedReview, ClinikoReviewRequestFailure> {
  if (typeof notes !== "string") return err({ kind: "invalidReviewRequest" });
  const parts = notes.split("\n");
  if (parts.length !== 4 || !parts[0]?.startsWith("Abby request ") || ![header, correctionHeader, resendHeader, resendContentHeader, classHeader, classPassHeader, classPassCancellationHeader, classMoveHeader, classPassMoveHeader, stagedClassPassMoveHeader].includes(parts[1]!) ||
      parts[3] !== instruction || !validRecallSummary(parts.slice(1).join("\n"))) {
    return err({ kind: "invalidReviewRequest" });
  }
  const marker = parts[0].slice("Abby request ".length);
  if (!validRecallMarker(marker)) return err({ kind: "invalidReviewRequest" });
  let request: unknown;
  try {
    if (parts[1] === classPassMoveHeader || parts[1] === stagedClassPassMoveHeader) {
      if (!/^z1:[A-Za-z0-9_-]+$/.test(parts[2]!)) return err({ kind: "invalidReviewRequest" });
      const encoded = parts[2]!.slice(3), bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) return err({ kind: "invalidReviewRequest" });
      const json = new TextDecoder("utf-8", { fatal: true }).decode(inflateRawSync(bytes, { maxOutputLength: 8192 }));
      request = unpackPassMove(JSON.parse(json));
    } else request = JSON.parse(parts[2]!);
  } catch { return err({ kind: "invalidReviewRequest" }); }
  return validRequest(request) && parts[1] === reviewHeader(request.operation)
    ? ok({ marker, request }) : err({ kind: "invalidReviewRequest" });
}
