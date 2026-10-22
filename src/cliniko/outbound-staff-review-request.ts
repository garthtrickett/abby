import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";
import { packUuid, unpackUuid, packDigest, unpackDigest, packRecall, unpackRecall } from "./internal/outbound-note-packing.ts";
import { outboundLaunchAttemptDigest } from "./outbound-launch-attempt.ts";
import type { OutboundLaunchRecord } from "./outbound-launch-records.ts";

type Source = Readonly<{ recallRef: string; actionRef: string; digest: string }>;
/** Pending clinic work only. Original and notification sources require their
 * own current grants; this record establishes no stop/no-stop or call authority. */
export type OutboundStaffReviewRequest = Readonly<{
  actionRef: string; scope: LocationScope; businessId: string; credentialFingerprint: string; patientId: string;
  attempt: Source; notification: Source;
  state: "needsClinicReview"; reason: "contactCoverageUnresolved"; recordedAt: string;
}>;
type Failure = Readonly<{ kind: "invalidOutboundStaffReviewRequest" }>;
const invalid = (): Result<never, Failure> => err({ kind: "invalidOutboundStaffReviewRequest" });
const header = "Abby outbound staff review request v1";
const instruction = "Pending clinic review only. Contact remains unresolved; no no-stop evidence or call permission. Never replay.";
const exact = (value: unknown, fields: readonly string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...fields].sort().join(",");
const opaque = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value);
const numeric = (value: unknown) => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const source = (value: Source) => exact(value, ["recallRef", "actionRef", "digest"]) &&
  /^cliniko:recall:[1-9][0-9]{0,18}$/.test(value.recallRef) && validRecallMarker(value.actionRef) && digest(value.digest);

/** Stable across policy/key/code changes. Only an opaque original action enters
 * this domain; patient data and source digests never become local purpose keys. */
export function outboundStaffReviewActionRef(attemptActionRef: string): string | undefined {
  if (!validRecallMarker(attemptActionRef)) return undefined;
  const bytes = createHash("sha256").update(JSON.stringify(["abby.outbound-staff-review-purpose.v1", attemptActionRef])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex"), value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return value === attemptActionRef ? undefined : value;
}
function valid(value: OutboundStaffReviewRequest): boolean {
  return exact(value, ["actionRef", "scope", "businessId", "credentialFingerprint", "patientId", "attempt", "notification", "state", "reason", "recordedAt"]) &&
    validRecallMarker(value.actionRef) && exact(value.scope, ["tenantId", "clinicId", "locationId"]) && Object.values(value.scope).every(opaque) &&
    numeric(value.businessId) && numeric(value.patientId) && digest(value.credentialFingerprint) && source(value.attempt) && source(value.notification) &&
    value.actionRef === outboundStaffReviewActionRef(value.attempt.actionRef) && value.attempt.recallRef !== value.notification.recallRef &&
    new Set([value.actionRef, value.attempt.actionRef, value.notification.actionRef]).size === 3 &&
    value.state === "needsClinicReview" && value.reason === "contactCoverageUnresolved" && instant(value.recordedAt);
}
export function encodeOutboundStaffReviewRequest(value: OutboundStaffReviewRequest): Result<string, Failure> {
  try {
    if (!valid(value)) return invalid();
    const pack = (ref: Source) => [packRecall(ref.recallRef), packUuid(ref.actionRef), packDigest(ref.digest)];
    const fields = [[value.scope.tenantId, value.scope.clinicId, value.scope.locationId], value.businessId, packDigest(value.credentialFingerprint),
      value.patientId, pack(value.attempt), pack(value.notification), value.recordedAt];
    const summary = `${header}\n${JSON.stringify(fields)}\n${instruction}`;
    return validRecallSummary(summary) ? ok(formatRecallNote(value.actionRef, summary)) : invalid();
  } catch { return invalid(); }
}
export function decodeOutboundStaffReviewRequest(notes: unknown): Result<OutboundStaffReviewRequest, Failure> {
  try {
    if (typeof notes !== "string" || notes.length > 1050) return invalid();
    const lines = notes.split("\n");
    if (lines.length !== 4 || !lines[0]!.startsWith("Abby request ") || lines[1] !== header || lines[3] !== instruction) return invalid();
    const fields: unknown = JSON.parse(lines[2]!);
    if (!Array.isArray(fields) || fields.length !== 7 || !Array.isArray(fields[0]) || fields[0].length !== 3 ||
        !Array.isArray(fields[4]) || fields[4].length !== 3 || !Array.isArray(fields[5]) || fields[5].length !== 3) return invalid();
    const unpack = (ref: unknown[]): Source => ({ recallRef: unpackRecall(ref[0]), actionRef: unpackUuid(ref[1]), digest: unpackDigest(ref[2]) });
    const value: OutboundStaffReviewRequest = { actionRef: lines[0]!.slice(13),
      scope: { tenantId: fields[0][0], clinicId: fields[0][1], locationId: fields[0][2] }, businessId: fields[1],
      credentialFingerprint: unpackDigest(fields[2]), patientId: fields[3], attempt: unpack(fields[4]), notification: unpack(fields[5]),
      state: "needsClinicReview", reason: "contactCoverageUnresolved", recordedAt: fields[6] };
    const encoded = encodeOutboundStaffReviewRequest(value);
    if (!encoded.ok || encoded.value !== notes) return invalid();
    return ok(Object.freeze({ ...value, scope: Object.freeze(value.scope), attempt: Object.freeze(value.attempt), notification: Object.freeze(value.notification) }));
  } catch { return invalid(); }
}
/** Private fingerprint only; never a local queue key or current source grant. */
export function outboundStaffReviewRequestDigest(value: OutboundStaffReviewRequest): string | undefined {
  const encoded = encodeOutboundStaffReviewRequest(value);
  return encoded.ok ? createHash("sha256").update(JSON.stringify(["abby.outbound-staff-review-request.v1", encoded.value])).digest("hex") : undefined;
}
export function outboundStaffReviewMatchesAttempt(value: OutboundStaffReviewRequest, original: OutboundLaunchRecord): boolean {
  try {
    if (!encodeOutboundStaffReviewRequest(value).ok) return false;
    const a = original.attempt;
    return value.attempt.recallRef === original.recallRef && value.attempt.actionRef === a.actionRef && value.attempt.digest === outboundLaunchAttemptDigest(a) &&
      value.scope.tenantId === a.scope.tenantId && value.scope.clinicId === a.scope.clinicId && value.scope.locationId === a.scope.locationId &&
      value.businessId === a.businessId && value.credentialFingerprint === a.credentialFingerprint && value.patientId === a.patientId && value.recordedAt >= a.attemptedAt &&
      ![a.requestActionRef, a.campaignRef, a.approvalRef, a.effectRef, a.capacityAllocationRef, a.dncReferences?.actionRef, a.dncReferences?.approvalRef,
        a.contactReferences?.guardRef, a.contactReferences?.allocationRef, a.contactReferences?.outcomeActionRef].includes(value.actionRef);
  } catch { return false; }
}
