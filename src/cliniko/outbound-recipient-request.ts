import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { outboundContactTime } from "../core/outbound-contact-time.ts";
import type { OutboundContactSchedule } from "../core/outbound-contact-time.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";

/** Private prospective native context. Neither notes nor their fingerprint grant
 * audience/contact/DNC/launch/patient permission or prove an attempted call. */
export type OutboundRecipientRequest = Readonly<{
  actionRef: string; campaignRef: string; effectRef: string; approvalRef: string;
  scope: LocationScope; businessId: string; credentialFingerprint: string; patientId: string;
  purpose: "followUp" | "sickDay";
  recipient: Readonly<{ kind: "voice"; number: string }>;
  policy: Readonly<{ version: string; digest: string }>;
  schedule: OutboundContactSchedule;
  /** Exact original individual target context, not current clinical authority.
   * Sick-day work requires it; a general follow-up cannot infer a target. */
  appointment?: Readonly<{ ref: string; digest: string }>;
  requestedAt: string;
}>;
type Failure = Readonly<{ kind: "invalidOutboundRequest" }>;
const header = "Abby outbound recipient request v1";
const instruction = "Private context only. No contact, patient authority or launch proof. Never replay an old effect.";
const invalid = () => err({ kind: "invalidOutboundRequest" as const });
const exact = (v: unknown, keys: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const opaque = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const numeric = (v: unknown) => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function valid(r: OutboundRecipientRequest): boolean {
  const fields = ["actionRef", "campaignRef", "effectRef", "approvalRef", "scope", "businessId", "credentialFingerprint",
    "patientId", "purpose", "recipient", "policy", "schedule", "requestedAt"];
  if (!r || !exact(r, Object.hasOwn(r, "appointment") ? [...fields, "appointment"] : fields)) return false;
  const ids = [r.actionRef, r.campaignRef, r.effectRef, r.approvalRef];
  if (!ids.every(validRecallMarker) || new Set(ids).size !== ids.length || !["followUp", "sickDay"].includes(r.purpose) ||
      !exact(r.scope, ["tenantId", "clinicId", "locationId"]) || !Object.values(r.scope).every(opaque) ||
      !numeric(r.businessId) || !numeric(r.patientId) || !digest(r.credentialFingerprint) ||
      !exact(r.recipient, ["kind", "number"]) || r.recipient.kind !== "voice" || typeof r.recipient.number !== "string" || !/^\+[1-9][0-9]{7,14}$/.test(r.recipient.number) ||
      !exact(r.policy, ["version", "digest"]) || typeof r.policy.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(r.policy.version) || !digest(r.policy.digest) ||
      !instant(r.requestedAt) || outboundContactTime(r.schedule, r.requestedAt).kind === "invalid" || r.requestedAt >= r.schedule.expiresAt ||
      !r.schedule.weekdays.every((d, i, all) => i === 0 || d > all[i-1]!)) return false;
  if (Object.hasOwn(r, "appointment")) {
    const a = r.appointment;
    if (!a || !exact(a, ["ref", "digest"]) || typeof a.ref !== "string" || !/^cliniko:appointment:[1-9][0-9]{0,18}$/.test(a.ref) || !digest(a.digest)) return false;
  } else if (r.purpose === "sickDay") return false;
  return true;
}
export function encodeOutboundRecipientRequest(r: OutboundRecipientRequest): Result<string, Failure> {
  try {
    if (!valid(r)) return invalid();
    const s = r.schedule, payload = [r.campaignRef, r.effectRef, r.approvalRef, [r.scope.tenantId, r.scope.clinicId, r.scope.locationId],
      r.businessId, r.credentialFingerprint, r.patientId, r.purpose, r.recipient.number, [r.policy.version, r.policy.digest],
      [s.notBefore, s.expiresAt, s.timeZone, s.weekdays, s.opensAt, s.closesAt], r.appointment ? [r.appointment.ref, r.appointment.digest] : null, r.requestedAt];
    const summary = `${header}\n${JSON.stringify(payload)}\n${instruction}`;
    return validRecallSummary(summary) ? ok(formatRecallNote(r.actionRef, summary)) : invalid();
  } catch { return invalid(); }
}
export function decodeOutboundRecipientRequest(notes: unknown): Result<OutboundRecipientRequest, Failure> {
  try {
    if (typeof notes !== "string" || notes.length > 1_050) return invalid();
    const lines = notes.split("\n");
    if (lines.length !== 4 || !lines[0]!.startsWith("Abby request ") || lines[1] !== header || lines[3] !== instruction) return invalid();
    const a: unknown = JSON.parse(lines[2]!);
    if (!Array.isArray(a) || a.length !== 13 || !Array.isArray(a[3]) || a[3].length !== 3 ||
        !Array.isArray(a[9]) || a[9].length !== 2 || !Array.isArray(a[10]) || a[10].length !== 6 ||
        !(a[11] === null || Array.isArray(a[11]) && a[11].length === 2)) return invalid();
    const r: OutboundRecipientRequest = { actionRef: lines[0]!.slice(13), campaignRef: a[0], effectRef: a[1], approvalRef: a[2],
      scope: { tenantId: a[3][0], clinicId: a[3][1], locationId: a[3][2] }, businessId: a[4], credentialFingerprint: a[5], patientId: a[6],
      purpose: a[7], recipient: { kind: "voice", number: a[8] }, policy: { version: a[9][0], digest: a[9][1] },
      schedule: { notBefore: a[10][0], expiresAt: a[10][1], timeZone: a[10][2], weekdays: a[10][3], opensAt: a[10][4], closesAt: a[10][5] },
      ...(a[11] === null ? {} : { appointment: { ref: a[11][0], digest: a[11][1] } }), requestedAt: a[12] };
    const encoded = encodeOutboundRecipientRequest(r);
    if (!encoded.ok || encoded.value !== notes) return invalid();
    return ok(Object.freeze({ ...r, scope: Object.freeze({ ...r.scope }), recipient: Object.freeze({ ...r.recipient }), policy: Object.freeze({ ...r.policy }),
      schedule: Object.freeze({ ...r.schedule, weekdays: Object.freeze([...r.schedule.weekdays]) }),
      ...(r.appointment ? { appointment: Object.freeze({ ...r.appointment }) } : {}) }));
  } catch { return invalid(); }
}
/** Private native-context fingerprint only. Never store it or its input in SQL. */
export function outboundRecipientRequestDigest(request: OutboundRecipientRequest): string | undefined {
  const encoded = encodeOutboundRecipientRequest(request);
  return encoded.ok ? createHash("sha256").update(JSON.stringify(["abby.outbound-recipient-request.v1", encoded.value])).digest("hex") : undefined;
}
