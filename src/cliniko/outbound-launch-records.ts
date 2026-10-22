import type { PatientRecallSnapshot } from "./internal/patient-recall-snapshot.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { NativeOutboundRecords } from "./internal/outbound-native-record.ts";
import type { NativeOutboundFailure, NativeOutboundRetention, NativeOutboundReadBinding, NativeOutboundReadAuthority } from "./internal/outbound-native-record.ts";
import { encodeOutboundLaunchAttempt, decodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "./outbound-launch-attempt.ts";
import type { OutboundLaunchAttempt } from "./outbound-launch-attempt.ts";
import { outboundLaunchConfigShard, outboundLaunchRecordSelection, outboundLaunchRecordOwnerBinding } from "./internal/outbound-launch-record-context.ts";
import type { OutboundLaunchRecordConfig, OutboundLaunchRecordSelection } from "./internal/outbound-launch-record-context.ts";
export type { OutboundLaunchRecordConfig, OutboundLaunchRecordSelection } from "./internal/outbound-launch-record-context.ts";
export { outboundLaunchRecordSelection, outboundLaunchRecordOwnerBinding } from "./internal/outbound-launch-record-context.ts";

export type OutboundLaunchRecordQuery = OutboundLaunchRecordSelection & Readonly<{ ownerBinding: string;
  operation: "retainPossibleLaunch" | "readPossibleLaunch"; actionRef: string; patientId: string; recallRef?: string; recallAt?: string; includeArchived?: true;
  attempt?: OutboundLaunchAttempt; attemptDigest?: string }>;
export type OutboundLaunchReadAuthority = NativeOutboundReadAuthority<OutboundLaunchRecordQuery>;
export type OutboundLaunchRecordAuthority = OutboundLaunchReadAuthority & Readonly<{ producerAdmitted(query: OutboundLaunchRecordQuery,signal: AbortSignal): Promise<boolean> }>;
export type OutboundLaunchRecord = Readonly<{ kind: "possibleLaunchContext"; recallRef: string; attempt: OutboundLaunchAttempt;
  recallAt: string; createdAt: string; updatedAt: string; recalled: boolean; recalledAt: string|null; archivedAt: string|null }>;
export type OutboundLaunchRecordFailure = NativeOutboundFailure;
/** Retains possible-attempt evidence only. An acknowledged record is never a
 * launch/delivery/terminal receipt. The owning launcher independently consumes
 * approval/effect before possible-attempt retention and independently admits a call. */
export class ClinikoOutboundLaunchRecords {
  readonly #records: NativeOutboundRecords<OutboundLaunchAttempt,OutboundLaunchRecordQuery>;
  private constructor(config: OutboundLaunchRecordConfig,sourceShard: string,owner: string,read: OutboundLaunchReadAuthority,port: typeof fetch,
    write?: Readonly<{producer:OutboundLaunchRecordAuthority["producerAdmitted"];barrier:OutboundEffectBarrier}>) {
    const selection=outboundLaunchRecordSelection(config);
    this.#records=new NativeOutboundRecords({...config,credentialFingerprint:selection.credentialFingerprint,typeId:selection.outboundAttemptRecallTypeId,
      ...(config.clock?{clock:config.clock.bind(config)}:{})},sourceShard,owner,read,port,
      {encode:encodeOutboundLaunchAttempt,decode:decodeOutboundLaunchAttempt,recordedAt:a=>a.attemptedAt,expiresAt:a=>a.dispatchNotAfter},
      input=>Object.freeze({...selection,ownerBinding:owner,operation:input.method==="POST"?"retainPossibleLaunch":"readPossibleLaunch",
        actionRef:input.actionRef,patientId:input.patientId,...(input.method==="GET"?{includeArchived:true as const}:{}),...(input.recallRef?{recallRef:input.recallRef}:{}),...(input.recallAt?{recallAt:input.recallAt}:{}),
        ...(input.record?{attempt:input.record,attemptDigest:outboundLaunchAttemptDigest(input.record)!}:{})}),write);
  }
  static create(config: OutboundLaunchRecordConfig,authority: OutboundLaunchRecordAuthority,barrier: OutboundEffectBarrier,port: typeof fetch=fetch):Result<ClinikoOutboundLaunchRecords,NativeOutboundFailure> {
    try {
      const sourceShard=outboundLaunchConfigShard(config,port),owner=outboundLaunchRecordOwnerBinding(config);
      if(!sourceShard||!owner||[authority?.allows,authority?.current,authority?.producerAdmitted,barrier?.matches,barrier?.claimOnce].some(f=>typeof f!=="function")||
        barrier.matches(config.scope,owner)!==true)return err({kind:"invalidConfig"});
      return ok(new ClinikoOutboundLaunchRecords(config,sourceShard,owner,authority,port,{producer:authority.producerAdmitted.bind(authority),barrier}));
    }catch{return err({kind:"invalidConfig"});}
  }
  static createReadOnly(config: OutboundLaunchRecordConfig,authority:OutboundLaunchReadAuthority,port:typeof fetch=fetch):Result<Pick<ClinikoOutboundLaunchRecords,"readPossibleAttempt">,NativeOutboundFailure> {
    try {
      const sourceShard=outboundLaunchConfigShard(config,port),owner=outboundLaunchRecordOwnerBinding(config);
      if(!sourceShard||!owner||typeof authority?.allows!=="function"||typeof authority.current!=="function")return err({kind:"invalidConfig"});
      return ok(new ClinikoOutboundLaunchRecords(config,sourceShard,owner,authority,port));
    }catch{return err({kind:"invalidConfig"});}
  }
  retainPossibleAttemptOnce(attempt:OutboundLaunchAttempt,recallAt:string,signal:AbortSignal):Promise<Result<NativeOutboundRetention,NativeOutboundFailure>> {
    return this.#records.retain(attempt,recallAt,signal);
  }
  async readPossibleAttempt(input:NativeOutboundReadBinding,signal:AbortSignal,history?:PatientRecallSnapshot):Promise<Result<OutboundLaunchRecord,NativeOutboundFailure>> {
    const result=await this.#records.read(input,signal,history);if(!result.ok)return result;const r=result.value;
    return ok(Object.freeze({kind:"possibleLaunchContext",recallRef:r.recallRef,attempt:r.record,recallAt:r.recallAt,
      createdAt:r.createdAt,updatedAt:r.updatedAt,recalled:r.recalled,recalledAt:r.recalledAt,archivedAt:r.archivedAt}));
  }
}
