import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";

/** Private clinic-owned decision provenance. No field, note or digest grants
 * current source access, reconsent authority, patient authority or permission to call. */
export type OutboundContactReview = Readonly<{
  actionRef: string; approvalRef: string; reviewerRef: string;
  scope: LocationScope; businessId: string; credentialFingerprint: string;
  contactRecallTypeId: string; policy: Readonly<{ version: string; digest: string }>;
  patientId: string; recipient: Readonly<{ kind: "voice"; number: string }>;
  purposes: readonly ("followUp" | "sickDay")[];
  consent: "granted" | "withdrawn" | "unknown";
  doNotCall: "clear" | "blocked" | "unknown";
  revision: number; predecessor: Readonly<{ actionRef: string; digest: string }> | null;
  /** Independent explicit approval to supersede this exact predecessor. The
   * concrete current authority must separately verify it before using evidence. */
  reconsentApprovalRef: string | null;
  reviewedAt: string; effectiveFrom: string; effectiveUntil: string;
}>;
type Failure = Readonly<{ kind: "invalidOutboundContactReview" }>;
const invalid = () => err({ kind: "invalidOutboundContactReview" as const });
const header = "Abby voice contact review v1";
/** Recognize the family only to refuse unknown/unlisted native roles or
 * versions. A marker proves neither valid content nor clinic approval. */
export const hasOutboundContactReviewMarker = (notes: unknown): boolean => typeof notes === "string" &&
  /(^|\n)Abby voice contact review(?:[ \r\n]|$)/.test(notes);
const instruction = "Private decision history only. No current contact or reconsent authority. Never infer voice consent from marketing flags.";
const keys = ["actionRef", "approvalRef", "reviewerRef", "scope", "businessId", "credentialFingerprint", "contactRecallTypeId", "policy",
  "patientId", "recipient", "purposes", "consent", "doNotCall", "revision", "predecessor", "reconsentApprovalRef", "reviewedAt", "effectiveFrom", "effectiveUntil"];
const exact = (v: unknown, fields: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...fields].sort().join(",");
const opaque = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const numeric = (v: unknown) => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const hex = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export const contactReviewInstant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function valid(r: OutboundContactReview): boolean {
  if (!exact(r, keys)) return false;
  const ids = [r.actionRef, r.approvalRef, ...(r.predecessor ? [r.predecessor.actionRef] : []), ...(r.reconsentApprovalRef ? [r.reconsentApprovalRef] : [])];
  return ids.every(validRecallMarker) && new Set(ids).size === ids.length && opaque(r.reviewerRef) &&
    exact(r.scope, ["tenantId", "clinicId", "locationId"]) && Object.values(r.scope).every(opaque) &&
    numeric(r.businessId) && numeric(r.patientId) && numeric(r.contactRecallTypeId) && hex(r.credentialFingerprint) &&
    exact(r.policy, ["version", "digest"]) && opaque(r.policy.version) && r.policy.version.length <= 64 && hex(r.policy.digest) &&
    exact(r.recipient, ["kind", "number"]) && r.recipient.kind === "voice" && typeof r.recipient.number === "string" && /^\+[1-9][0-9]{7,14}$/.test(r.recipient.number) &&
    Array.isArray(r.purposes) && r.purposes.length >= 1 && r.purposes.length <= 2 &&
    r.purposes.every((p, i) => ["followUp", "sickDay"].includes(p) && (i === 0 || p > r.purposes[i - 1]!)) &&
    ["granted", "withdrawn", "unknown"].includes(r.consent) && ["clear", "blocked", "unknown"].includes(r.doNotCall) &&
    Number.isSafeInteger(r.revision) && r.revision >= 1 && r.revision <= 50 &&
    (r.revision === 1 ? r.predecessor === null && r.reconsentApprovalRef === null :
      exact(r.predecessor, ["actionRef", "digest"]) && hex(r.predecessor?.digest) &&
      (r.reconsentApprovalRef === null || validRecallMarker(r.reconsentApprovalRef))) &&
    contactReviewInstant(r.reviewedAt) && contactReviewInstant(r.effectiveFrom) && contactReviewInstant(r.effectiveUntil) &&
    r.reviewedAt <= r.effectiveFrom && r.effectiveFrom < r.effectiveUntil;
}
export function encodeOutboundContactReview(r: OutboundContactReview): Result<string, Failure> {
  try {
    if (!valid(r)) return invalid();
    const payload = [r.approvalRef, r.reviewerRef, [r.scope.tenantId, r.scope.clinicId, r.scope.locationId], r.businessId, r.credentialFingerprint,
      r.contactRecallTypeId, [r.policy.version, r.policy.digest], r.patientId, r.recipient.number, r.purposes, r.consent, r.doNotCall,
      r.revision, r.predecessor ? [r.predecessor.actionRef, r.predecessor.digest] : null, r.reconsentApprovalRef, r.reviewedAt, r.effectiveFrom, r.effectiveUntil];
    const summary = `${header}\n${JSON.stringify(payload)}\n${instruction}`;
    return validRecallSummary(summary) ? ok(formatRecallNote(r.actionRef, summary)) : invalid();
  } catch { return invalid(); }
}
export function decodeOutboundContactReview(notes: unknown): Result<OutboundContactReview, Failure> {
  try {
    if (typeof notes !== "string" || notes.length > 1050) return invalid();
    const lines = notes.split("\n");
    if (lines.length !== 4 || !lines[0]!.startsWith("Abby request ") || lines[1] !== header || lines[3] !== instruction) return invalid();
    const a: unknown = JSON.parse(lines[2]!);
    if (!Array.isArray(a) || a.length !== 18 || !Array.isArray(a[2]) || a[2].length !== 3 || !Array.isArray(a[6]) || a[6].length !== 2 ||
      !(a[13] === null || Array.isArray(a[13]) && a[13].length === 2)) return invalid();
    const review: OutboundContactReview = { actionRef: lines[0]!.slice(13), approvalRef: a[0], reviewerRef: a[1],
      scope: { tenantId: a[2][0], clinicId: a[2][1], locationId: a[2][2] }, businessId: a[3], credentialFingerprint: a[4],
      contactRecallTypeId: a[5], policy: { version: a[6][0], digest: a[6][1] }, patientId: a[7], recipient: { kind: "voice", number: a[8] },
      purposes: a[9], consent: a[10], doNotCall: a[11], revision: a[12], predecessor: a[13] === null ? null : { actionRef: a[13][0], digest: a[13][1] },
      reconsentApprovalRef: a[14], reviewedAt: a[15], effectiveFrom: a[16], effectiveUntil: a[17] };
    const encoded = encodeOutboundContactReview(review);
    if (!encoded.ok || encoded.value !== notes) return invalid();
    return ok(Object.freeze({ ...review, scope: Object.freeze({ ...review.scope }), policy: Object.freeze({ ...review.policy }),
      recipient: Object.freeze({ ...review.recipient }), purposes: Object.freeze([...review.purposes]),
      predecessor: review.predecessor ? Object.freeze({ ...review.predecessor }) : null }));
  } catch { return invalid(); }
}
/** Private fingerprint, never a local SQL key or substitute for current grants. */
export function outboundContactReviewDigest(review: OutboundContactReview): string | undefined {
  const encoded = encodeOutboundContactReview(review);
  return encoded.ok ? createHash("sha256").update(JSON.stringify(["abby.outbound-contact-review.v1", encoded.value])).digest("hex") : undefined;
}
