import { packUuid as compact, unpackUuid as expand, packDigest as compactDigest, unpackDigest as expandDigest } from "./internal/outbound-note-packing.ts";
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
  /** Present in v2: clinic-owned exact link to an opaque local allocation.
   * Older v1 evidence still prevents replay but cannot identify a held place. */
  capacityAllocationRef?: string;
  /** v3 reserves distinct opaque identities before dispatch for one possible
   * later DNC decision. These IDs approve no report, write or reconsent. */
  dncReferences?: Readonly<{ actionRef: string; approvalRef: string }>;
  /** v4: clinic-wide unresolved contact allocation and a distinct future native
   * outcome action. Guard identity is stable across campaigns/runtime changes;
   * these references alone prove no completion, DNC retention or permission. */
  contactReferences?: Readonly<{ guardRef: string; allocationRef: string; outcomeActionRef: string }>;
  attemptedAt: string; dispatchNotAfter: string;
}>;
type Failure = Readonly<{ kind: "invalidOutboundLaunchAttempt" }>;
const invalid = () => err({ kind: "invalidOutboundLaunchAttempt" as const });
const header = "Abby possible outbound launch v1";
const capacityHeader = "Abby possible outbound launch v2";
const dncHeader = "Abby possible outbound launch v3";
const contactHeader = "Abby possible outbound launch v4";
const instruction = "Possible attempt only. No launch, delivery, terminal or clinical result proved. Never replay this effect.";
const exact = (v: unknown, keys: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const numeric = (v: unknown) => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const opaque = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
// V3 and v4 use the lossless 22-character representation of already-validated
// random UUIDs. Even with two extra IDs, its note is shorter than the same v2
// context. Public objects, native permission queries and SQL still use UUIDs.
function valid(a: OutboundLaunchAttempt): boolean {
  const fields = ["actionRef","requestRecallRef","requestActionRef","requestDigest","campaignRef","approvalRef","effectRef",
    "scope","businessId","credentialFingerprint","patientId","provider","attemptedAt","dispatchNotAfter"];
  if (!exact(a, fields) && !exact(a, [...fields, "capacityAllocationRef"]) && !exact(a, [...fields, "capacityAllocationRef", "dncReferences"]) && !exact(a, [...fields, "capacityAllocationRef", "dncReferences", "contactReferences"])) return false;
  if (Object.hasOwn(a, "dncReferences") && (!Object.hasOwn(a, "capacityAllocationRef") || !exact(a.dncReferences, ["actionRef", "approvalRef"]))) return false;
  if (Object.hasOwn(a, "contactReferences") && (!a.capacityAllocationRef || !a.dncReferences ||
      !exact(a.contactReferences, ["guardRef", "allocationRef", "outcomeActionRef"]))) return false;
  const ids=[a.actionRef,a.requestActionRef,a.campaignRef,a.approvalRef,a.effectRef,...(Object.hasOwn(a,"capacityAllocationRef")?[a.capacityAllocationRef]:[]),
    ...(a.dncReferences ? [a.dncReferences.actionRef, a.dncReferences.approvalRef] : []),
    ...(a.contactReferences ? [a.contactReferences.guardRef, a.contactReferences.allocationRef, a.contactReferences.outcomeActionRef] : [])];
  return ids.every(validRecallMarker) && new Set(ids).size===ids.length && typeof a.requestRecallRef==="string" && /^cliniko:recall:[1-9][0-9]{0,18}$/.test(a.requestRecallRef) &&
    digest(a.requestDigest) && exact(a.scope,["tenantId","clinicId","locationId"]) && Object.values(a.scope).every(opaque) &&
    numeric(a.businessId) && numeric(a.patientId) && digest(a.credentialFingerprint) && exact(a.provider,["ref","bindingDigest"]) && opaque(a.provider.ref) && digest(a.provider.bindingDigest) &&
    instant(a.attemptedAt) && instant(a.dispatchNotAfter) && a.attemptedAt<a.dispatchNotAfter;
}
export function encodeOutboundLaunchAttempt(a: OutboundLaunchAttempt): Result<string,Failure> {
  try {
    if(!valid(a))return invalid();
    const ref = a.dncReferences ? compact : (value: string) => value;
    const hash = a.contactReferences ? compactDigest : (value: string) => value;
    const payload=[a.contactReferences ? a.requestRecallRef.slice("cliniko:recall:".length) : a.requestRecallRef,ref(a.requestActionRef),hash(a.requestDigest),ref(a.campaignRef),ref(a.approvalRef),ref(a.effectRef),
      [a.scope.tenantId,a.scope.clinicId,a.scope.locationId],a.businessId,hash(a.credentialFingerprint),a.patientId,[a.provider.ref,hash(a.provider.bindingDigest)],a.attemptedAt,a.dispatchNotAfter,
      ...(a.capacityAllocationRef === undefined ? [] : [ref(a.capacityAllocationRef)]), ...(a.dncReferences ? [[ref(a.dncReferences.actionRef), ref(a.dncReferences.approvalRef)]] : []),
      ...(a.contactReferences ? [[ref(a.contactReferences.guardRef), ref(a.contactReferences.allocationRef), ref(a.contactReferences.outcomeActionRef)]] : [])];
    const summary=`${a.contactReferences ? contactHeader : a.dncReferences ? dncHeader : a.capacityAllocationRef === undefined ? header : capacityHeader}\n${JSON.stringify(payload)}\n${instruction}`;
    return validRecallSummary(summary)?ok(formatRecallNote(a.actionRef,summary)):invalid();
  }catch{return invalid();}
}
export function decodeOutboundLaunchAttempt(notes: unknown): Result<OutboundLaunchAttempt,Failure> {
  try {
    if(typeof notes!=="string"||notes.length>1050)return invalid();const lines=notes.split("\n");
    if(lines.length!==4||!lines[0]!.startsWith("Abby request ")||(lines[1]!==header&&lines[1]!==capacityHeader&&lines[1]!==dncHeader&&lines[1]!==contactHeader)||lines[3]!==instruction)return invalid();
    const a:unknown=JSON.parse(lines[2]!);
    if(!Array.isArray(a)||a.length!==(lines[1]===contactHeader?16:lines[1]===dncHeader?15:lines[1]===capacityHeader?14:13)||!Array.isArray(a[6])||a[6].length!==3||!Array.isArray(a[10])||a[10].length!==2||
      (lines[1]===dncHeader||lines[1]===contactHeader)&&(!Array.isArray(a[14])||a[14].length!==2)||
      lines[1]===contactHeader&&(!Array.isArray(a[15])||a[15].length!==3||typeof a[0]!=="string"))return invalid();
    const ref = (value: unknown): string => {
      if (lines[1] === dncHeader || lines[1] === contactHeader) return expand(value);
      if (typeof value !== "string") throw new Error("Invalid opaque reference"); return value;
    };
    const hash = (value: unknown): string => lines[1] === contactHeader ? expandDigest(value) : value as string;
    const result:OutboundLaunchAttempt={actionRef:lines[0]!.slice(13),requestRecallRef:lines[1] === contactHeader ? `cliniko:recall:${a[0]}` : a[0],requestActionRef:ref(a[1]),requestDigest:hash(a[2]),campaignRef:ref(a[3]),approvalRef:ref(a[4]),effectRef:ref(a[5]),
      scope:{tenantId:a[6][0],clinicId:a[6][1],locationId:a[6][2]},businessId:a[7],credentialFingerprint:hash(a[8]),patientId:a[9],provider:{ref:a[10][0],bindingDigest:hash(a[10][1])},attemptedAt:a[11],dispatchNotAfter:a[12],
      ...(lines[1]!==header?{capacityAllocationRef:ref(a[13])}:{}), ...(lines[1]===dncHeader||lines[1]===contactHeader?{dncReferences:{actionRef:ref(a[14][0]),approvalRef:ref(a[14][1])}}:{}),
      ...(lines[1]===contactHeader?{contactReferences:{guardRef:ref(a[15][0]),allocationRef:ref(a[15][1]),outcomeActionRef:ref(a[15][2])}}:{})};
    const encoded=encodeOutboundLaunchAttempt(result);if(!encoded.ok||encoded.value!==notes)return invalid();
    return ok(Object.freeze({...result,scope:Object.freeze({...result.scope}),provider:Object.freeze({...result.provider}),
      ...(result.dncReferences ? { dncReferences: Object.freeze({ ...result.dncReferences }) } : {}),
      ...(result.contactReferences ? { contactReferences: Object.freeze({ ...result.contactReferences }) } : {})}));
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
