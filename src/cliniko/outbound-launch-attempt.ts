import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { validRecallMarker, validRecallSummary, formatRecallNote } from "./recall-note.ts";
import { encodeOutboundRecipientRequest, outboundRecipientRequestDigest } from "./outbound-recipient-request.ts";
import type { OutboundRecipientRequest } from "./outbound-recipient-request.ts";

/** Private evidence of a possible launch, never launch/terminal/delivery proof.
 * No field or private digest belongs in local SQL. */
export type OutboundLaunchAttempt = Readonly<{
  actionRef: string; requestRecallRef: string; requestActionRef: string; requestDigest: string;
  campaignRef: string; approvalRef: string; effectRef: string;
  scope: LocationScope; businessId: string; credentialFingerprint: string; patientId: string;
  provider: Readonly<{ ref: string; bindingDigest: string }>;
  attemptedAt: string; dispatchNotAfter: string;
}>;
type Failure = Readonly<{ kind: "invalidOutboundLaunchAttempt" }>;
const invalid = () => err({ kind: "invalidOutboundLaunchAttempt" as const });
const header = "Abby possible outbound launch v1";
const instruction = "Possible attempt only. No launch, delivery, terminal or clinical result proved. Never replay this effect.";
const exact = (v: unknown, keys: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const numeric = (v: unknown) => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const opaque = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function valid(a: OutboundLaunchAttempt): boolean {
  if (!exact(a,["actionRef","requestRecallRef","requestActionRef","requestDigest","campaignRef","approvalRef","effectRef","scope","businessId","credentialFingerprint","patientId","provider","attemptedAt","dispatchNotAfter"])) return false;
  const ids=[a.actionRef,a.requestActionRef,a.campaignRef,a.approvalRef,a.effectRef];
  return ids.every(validRecallMarker) && new Set(ids).size===ids.length && typeof a.requestRecallRef==="string" && /^cliniko:recall:[1-9][0-9]{0,18}$/.test(a.requestRecallRef) &&
    digest(a.requestDigest) && exact(a.scope,["tenantId","clinicId","locationId"]) && Object.values(a.scope).every(opaque) &&
    numeric(a.businessId) && numeric(a.patientId) && digest(a.credentialFingerprint) && exact(a.provider,["ref","bindingDigest"]) && opaque(a.provider.ref) && digest(a.provider.bindingDigest) &&
    instant(a.attemptedAt) && instant(a.dispatchNotAfter) && a.attemptedAt<a.dispatchNotAfter;
}
export function encodeOutboundLaunchAttempt(a: OutboundLaunchAttempt): Result<string,Failure> {
  try {
    if(!valid(a))return invalid();
    const payload=[a.requestRecallRef,a.requestActionRef,a.requestDigest,a.campaignRef,a.approvalRef,a.effectRef,
      [a.scope.tenantId,a.scope.clinicId,a.scope.locationId],a.businessId,a.credentialFingerprint,a.patientId,[a.provider.ref,a.provider.bindingDigest],a.attemptedAt,a.dispatchNotAfter];
    const summary=`${header}\n${JSON.stringify(payload)}\n${instruction}`;
    return validRecallSummary(summary)?ok(formatRecallNote(a.actionRef,summary)):invalid();
  }catch{return invalid();}
}
export function decodeOutboundLaunchAttempt(notes: unknown): Result<OutboundLaunchAttempt,Failure> {
  try {
    if(typeof notes!=="string"||notes.length>1050)return invalid();const lines=notes.split("\n");
    if(lines.length!==4||!lines[0]!.startsWith("Abby request ")||lines[1]!==header||lines[3]!==instruction)return invalid();
    const a:unknown=JSON.parse(lines[2]!);
    if(!Array.isArray(a)||a.length!==13||!Array.isArray(a[6])||a[6].length!==3||!Array.isArray(a[10])||a[10].length!==2)return invalid();
    const result:OutboundLaunchAttempt={actionRef:lines[0]!.slice(13),requestRecallRef:a[0],requestActionRef:a[1],requestDigest:a[2],campaignRef:a[3],approvalRef:a[4],effectRef:a[5],
      scope:{tenantId:a[6][0],clinicId:a[6][1],locationId:a[6][2]},businessId:a[7],credentialFingerprint:a[8],patientId:a[9],provider:{ref:a[10][0],bindingDigest:a[10][1]},attemptedAt:a[11],dispatchNotAfter:a[12]};
    const encoded=encodeOutboundLaunchAttempt(result);if(!encoded.ok||encoded.value!==notes)return invalid();
    return ok(Object.freeze({...result,scope:Object.freeze({...result.scope}),provider:Object.freeze({...result.provider})}));
  }catch{return invalid();}
}
/** Exact source binding only; no current policy/contact/launch authority. A cold
 * matching possible attempt remains evidence after its dispatch window ends. */
export function outboundAttemptMatchesRequest(a: OutboundLaunchAttempt, request: OutboundRecipientRequest, recallRef: string): boolean {
  try {
    return encodeOutboundLaunchAttempt(a).ok && encodeOutboundRecipientRequest(request).ok && a.requestRecallRef===recallRef &&
      a.requestActionRef===request.actionRef && a.requestDigest===outboundRecipientRequestDigest(request) && a.campaignRef===request.campaignRef &&
      a.approvalRef===request.approvalRef && a.effectRef===request.effectRef && a.scope.tenantId===request.scope.tenantId && a.scope.clinicId===request.scope.clinicId &&
      a.scope.locationId===request.scope.locationId && a.businessId===request.businessId && a.credentialFingerprint===request.credentialFingerprint && a.patientId===request.patientId &&
      a.attemptedAt>=request.requestedAt && a.dispatchNotAfter<=request.schedule.expiresAt;
  }catch{return false;}
}
export function outboundLaunchAttemptDigest(a: OutboundLaunchAttempt): string | undefined {
  const encoded=encodeOutboundLaunchAttempt(a);return encoded.ok?createHash("sha256").update(JSON.stringify(["abby.outbound-launch-attempt.v1",encoded.value])).digest("hex"):undefined;
}
