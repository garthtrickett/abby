import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { validOutboundEffectRef } from "../core/outbound-effect-barrier.ts";
import { outboundContactTime } from "../core/outbound-contact-time.ts";
import type { OutboundContactSchedule } from "../core/outbound-contact-time.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { encodeOutboundRecipientRequest, decodeOutboundRecipientRequest } from "../cliniko/outbound-recipient-request.ts";
import type { OutboundRecipientRequest } from "../cliniko/outbound-recipient-request.ts";
import type { OutboundRecordSelection } from "../cliniko/outbound-recipient-records.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import { clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval, approvalRef, approvalInstant } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval, ClinicApprovalFailure } from "./owner-file-clinic-approval.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";

/** Non-patient clinic configuration only. This selects a native audience source,
 * never its members, their consent/DNC state or a supported launch provider. */
export type OutboundCampaignApproval = ClinicApproval & Readonly<{
  campaignRef: string; purpose: "followUp" | "sickDay"; providerRef: string; maximumConcurrent: number;
  audience: Readonly<{ kind: "nativeRecipientRequests"; businessId: string; credentialFingerprint: string;
    outboundRecallTypeId: string; recordPolicyDigest: string }>;
  schedule: OutboundContactSchedule;
}>;
type Config = Readonly<{ path: string; scope: LocationScope; directory: AdminDirectory; clock?: () => string; deadlineMs?: number }>;
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const hex = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function decode(value: unknown, scope: LocationScope): OutboundCampaignApproval | undefined {
  const common = decodeClinicApproval(value,scope,[...clinicApprovalKeys,"campaignRef","purpose","providerRef","maximumConcurrent","audience","schedule"]);
  const row=object(value), audience=object(row?.audience), schedule=object(row?.schedule);
  if(!common || !row || !audience || !schedule || !validOutboundEffectRef(row.campaignRef) || !["followUp","sickDay"].includes(String(row.purpose)) ||
    !approvalRef(row.providerRef) || !Number.isSafeInteger(row.maximumConcurrent) || Number(row.maximumConcurrent)<1 || Number(row.maximumConcurrent)>1000 ||
    Object.keys(audience).sort().join(",")!=="businessId,credentialFingerprint,kind,outboundRecallTypeId,recordPolicyDigest" || audience.kind!=="nativeRecipientRequests" ||
    !validClinikoId(audience.businessId) || !validClinikoId(audience.outboundRecallTypeId) || !hex(audience.credentialFingerprint) || !hex(audience.recordPolicyDigest) ||
    outboundContactTime(schedule as unknown as OutboundContactSchedule,String(schedule.notBefore)).kind==="invalid" ||
    !Array.isArray(schedule.weekdays) || schedule.weekdays.join(",")!==[...schedule.weekdays].sort((a,b)=>a-b).join(",") ||
    String(schedule.notBefore)<common.effectiveFrom || String(schedule.expiresAt)>common.effectiveUntil) return undefined;
  return value as OutboundCampaignApproval;
}
const scheduleKey = (s: OutboundContactSchedule) => JSON.stringify([s.notBefore,s.expiresAt,s.timeZone,s.weekdays,s.opensAt,s.closesAt]);
async function bounded<T>(signal: AbortSignal, ms: number, task: () => Promise<T>): Promise<T | undefined> {
  if(!(signal instanceof AbortSignal) || signal.aborted) return undefined;
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),ms), combined=AbortSignal.any([signal,deadline.signal]),began=performance.now();
  try {const result=await awaitUntilAbort(Promise.resolve().then(task),combined);return combined.aborted || performance.now()-began>ms?undefined:result;}
  catch{return undefined;}finally{clearTimeout(timer);deadline.abort();}
}
/** Current campaign-definition approval only. No patient/contact/DNC, audience
 * membership, producer/restore, capacity claim or launch authority is supplied. */
export class OwnerFileOutboundCampaign {
  readonly #source: OwnerFileClinicApproval<OutboundCampaignApproval>;
  readonly #clock: () => string;
  readonly #deadlineMs: number;
  readonly #capturedAt: number;
  private constructor(source: OwnerFileClinicApproval<OutboundCampaignApproval>, clock: () => string, deadlineMs: number, capturedAt: number) {
    this.#source=source;this.#clock=clock;this.#deadlineMs=deadlineMs;this.#capturedAt=capturedAt;
  }
  static async capture(config: Config, signal: AbortSignal): Promise<Result<OwnerFileOutboundCampaign,ClinicApprovalFailure>> {
    try {
      const ms=config.deadlineMs??15000;
      if(!Number.isSafeInteger(ms)||ms<1||ms>15000||typeof config.directory?.findByRef!=="function"||typeof config.directory.findByEmail!=="function"||
        config.clock!==undefined&&typeof config.clock!=="function")return err({kind:"unavailable"});
      const clock=config.clock?.bind(config)??(()=>new Date().toISOString()),at=approvalInstant(clock());if(at===undefined)return err({kind:"unavailable"});
      const directory=Object.freeze({findByRef:config.directory.findByRef.bind(config.directory),findByEmail:config.directory.findByEmail.bind(config.directory)});
      const captured=Object.freeze({path:config.path,scope:Object.freeze({...config.scope}),directory,decode,clock});
      const source=await bounded(signal,ms,()=>OwnerFileClinicApproval.capture(captured));
      const end=approvalInstant(clock());if(!source?.ok||signal.aborted||end===undefined||end<at)return err({kind:"unavailable"});
      return ok(new OwnerFileOutboundCampaign(source.value,clock,ms,at));
    }catch{return err({kind:"unavailable"});}
  }
  /** Non-patient binding of exact approved bytes and current approver membership.
   * A request must cite it, but citing it is not an independent action grant. */
  bindingFingerprint(): string {return createHash("sha256").update(JSON.stringify(["abby.outbound-campaign-policy.v1",this.#source.bindingFingerprint()])).digest("hex");}
  async currentFor(selection: OutboundRecordSelection, input: OutboundRecipientRequest, signal: AbortSignal): Promise<Result<OutboundCampaignApproval|undefined,ClinicApprovalFailure>> {
    try {
      const began=approvalInstant(this.#clock());if(began===undefined||began<this.#capturedAt)return err({kind:"unavailable"});
      const bound=Object.freeze({...selection,scope:Object.freeze({...selection.scope})});
      const encoded=encodeOutboundRecipientRequest(input);if(!encoded.ok)return ok(undefined);
      const decoded=decodeOutboundRecipientRequest(encoded.value);if(!decoded.ok)return ok(undefined);const request=decoded.value;
      const found=await bounded(signal,this.#deadlineMs,()=>this.#source.current(request.scope));if(!found)return err({kind:"unavailable"});if(!found.ok||!found.value)return found;
      const policy=found.value,a=policy.audience,end=approvalInstant(this.#clock());
      if(signal.aborted||end===undefined||end<began)return err({kind:"unavailable"});
      if(end<Date.parse(policy.effectiveFrom)||end>=Date.parse(policy.effectiveUntil))return ok(undefined);
      if(Object.keys(bound).sort().join(",")!=="businessId,credentialFingerprint,outboundRecallTypeId,recordPolicyDigest,scope" ||
        !sameScope(bound.scope,policy.scope)||!sameScope(request.scope,policy.scope)||request.campaignRef!==policy.campaignRef||request.purpose!==policy.purpose||
        bound.businessId!==a.businessId||bound.credentialFingerprint!==a.credentialFingerprint||bound.outboundRecallTypeId!==a.outboundRecallTypeId||bound.recordPolicyDigest!==a.recordPolicyDigest||
        request.businessId!==a.businessId||request.credentialFingerprint!==a.credentialFingerprint||request.policy.version!==policy.revision||request.policy.digest!==this.bindingFingerprint()||
        scheduleKey(request.schedule)!==scheduleKey(policy.schedule))return ok(undefined);
      return ok(Object.freeze({...policy,scope:Object.freeze({...policy.scope}),audience:Object.freeze({...a}),schedule:Object.freeze({...policy.schedule,weekdays:Object.freeze([...policy.schedule.weekdays])})}));
    }catch{return err({kind:"unavailable"});}
  }
}
