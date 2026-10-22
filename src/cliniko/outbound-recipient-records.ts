import type { PatientRecallSnapshot } from "./internal/patient-recall-snapshot.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { encodeOutboundRecipientRequest, decodeOutboundRecipientRequest, outboundRecipientRequestDigest } from "./outbound-recipient-request.ts";
import type { OutboundRecipientRequest } from "./outbound-recipient-request.ts";
import { outboundConfigShard, outboundRecordSelection, outboundRecordOwnerBinding } from "./internal/outbound-record-context.ts";
import type { OutboundRecordConfig, OutboundRecordSelection } from "./internal/outbound-record-context.ts";
import { NativeOutboundRecords } from "./internal/outbound-native-record.ts";
import type { NativeOutboundFailure, NativeOutboundRetention, NativeOutboundReadBinding } from "./internal/outbound-native-record.ts";
export type { OutboundRecordConfig, OutboundRecordSelection } from "./internal/outbound-record-context.ts";
export { outboundRecordOwnerBinding } from "./internal/outbound-record-context.ts";

export type OutboundRecordQuery = OutboundRecordSelection & Readonly<{
  ownerBinding: string; operation: "retainRecipientRequest" | "readRecipientRequest";
  actionRef: string; patientId: string; recallRef?: string; recallAt?: string; includeArchived?: true;
  request?: OutboundRecipientRequest; requestDigest?: string;
}>;
/** Independent native-record grants. These grant no audience/contact/DNC,
 * campaign/launch/patient authority. Reads need no effect-producer admission. */
export type OutboundRecordReadAuthority = Readonly<{
  allows(query: OutboundRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundRecordQuery, signal: AbortSignal): boolean;
}>;
export type OutboundRecordAuthority = OutboundRecordReadAuthority & Readonly<{
  producerAdmitted(query: OutboundRecordQuery, signal: AbortSignal): Promise<boolean>;
}>;
export type OutboundRecordFailure = NativeOutboundFailure;
export type OutboundRecipientRecord = Readonly<{ kind: "recipientRequestContext"; recallRef: string; request: OutboundRecipientRequest;
  recallAt: string; createdAt: string; updatedAt: string; recalled: boolean; recalledAt: string | null; archivedAt: string | null }>;
export type OutboundRecordRetention = NativeOutboundRetention;
/** Exact native private request create/read. No schedule/launch is performed. */
export class ClinikoOutboundRecipientRecords {
  readonly #records: NativeOutboundRecords<OutboundRecipientRequest,OutboundRecordQuery>;
  private constructor(config: OutboundRecordConfig, shard: string, owner: string, read: OutboundRecordReadAuthority,
    port: typeof fetch, write?: Readonly<{ producer: OutboundRecordAuthority["producerAdmitted"]; barrier: OutboundEffectBarrier }>) {
    const selection=outboundRecordSelection(config);
    this.#records=new NativeOutboundRecords({...config,credentialFingerprint:selection.credentialFingerprint,typeId:selection.outboundRecallTypeId,
      ...(config.clock?{clock:config.clock.bind(config)}:{})},shard,owner,read,port,
      {encode:encodeOutboundRecipientRequest,decode:decodeOutboundRecipientRequest,recordedAt:r=>r.requestedAt,expiresAt:r=>r.schedule.expiresAt},
      input=>Object.freeze({...selection,ownerBinding:owner,operation:input.method==="POST"?"retainRecipientRequest":"readRecipientRequest",
        actionRef:input.actionRef,patientId:input.patientId,...(input.method==="GET"?{includeArchived:true as const}:{}),...(input.recallRef?{recallRef:input.recallRef}:{}),...(input.recallAt?{recallAt:input.recallAt}:{}),
        ...(input.record?{request:input.record,requestDigest:outboundRecipientRequestDigest(input.record)!}:{})}),write);
  }
  static create(config: OutboundRecordConfig, authority: OutboundRecordAuthority, barrier: OutboundEffectBarrier,
    port: typeof fetch = fetch): Result<ClinikoOutboundRecipientRecords, OutboundRecordFailure> {
    try {
      const shard=outboundConfigShard(config,port),owner=outboundRecordOwnerBinding(config);
      if(!shard||!owner||[authority?.allows,authority?.current,authority?.producerAdmitted,barrier?.matches,barrier?.claimOnce].some(f=>typeof f!=="function")||
        barrier.matches(config.scope,owner)!==true)return err({kind:"invalidConfig"});
      return ok(new ClinikoOutboundRecipientRecords(config,shard,owner,authority,port,{producer:authority.producerAdmitted.bind(authority),barrier}));
    }catch{return err({kind:"invalidConfig"});}
  }
  static createReadOnly(config: OutboundRecordConfig, authority: OutboundRecordReadAuthority,
    port: typeof fetch = fetch): Result<Pick<ClinikoOutboundRecipientRecords,"readRequest">,OutboundRecordFailure> {
    try {
      const shard=outboundConfigShard(config,port),owner=outboundRecordOwnerBinding(config);
      if(!shard||!owner||typeof authority?.allows!=="function"||typeof authority.current!=="function")return err({kind:"invalidConfig"});
      return ok(new ClinikoOutboundRecipientRecords(config,shard,owner,authority,port));
    }catch{return err({kind:"invalidConfig"});}
  }
  retainRequestOnce(input: OutboundRecipientRequest, recallAt: string, signal: AbortSignal): Promise<Result<OutboundRecordRetention,OutboundRecordFailure>> {
    return this.#records.retain(input,recallAt,signal);
  }
  async readRequest(input: NativeOutboundReadBinding, signal: AbortSignal, history?: PatientRecallSnapshot): Promise<Result<OutboundRecipientRecord,OutboundRecordFailure>> {
    const result=await this.#records.read(input,signal,history);if(!result.ok)return result;const r=result.value;
    return ok(Object.freeze({kind:"recipientRequestContext",recallRef:r.recallRef,request:r.record,recallAt:r.recallAt,
      createdAt:r.createdAt,updatedAt:r.updatedAt,recalled:r.recalled,recalledAt:r.recalledAt,archivedAt:r.archivedAt}));
  }
}
