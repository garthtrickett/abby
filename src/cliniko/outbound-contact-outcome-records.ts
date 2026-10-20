import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnedBodyError, ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { NativeOutboundRecords } from "./internal/outbound-native-record.ts";
import type { NativeOutboundFailure, NativeOutboundRetention, NativeOutboundReadBinding, NativeOutboundReadAuthority } from "./internal/outbound-native-record.ts";
import { outboundConfigShard, outboundNativeInstant } from "./internal/outbound-record-context.ts";
import { readPatientRecallHistory, PatientRecallHistoryError } from "./internal/patient-recall-history.ts";
import { clinikoCredentialFingerprint, claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { encodeOutboundContactOutcome, decodeOutboundContactOutcome, outboundContactOutcomeDigest, outboundContactOutcomeMatchesAttempt } from "./outbound-contact-outcome.ts";
import type { OutboundContactOutcome } from "./outbound-contact-outcome.ts";
import { outboundLaunchAttemptDigest, encodeOutboundLaunchAttempt, decodeOutboundLaunchAttempt } from "./outbound-launch-attempt.ts";
import type { OutboundLaunchRecord } from "./outbound-launch-records.ts";

export type OutboundContactOutcomeConfig = Readonly<{ scope: LocationScope; businessId: string; apiKey: string; contactEmail: string;
  outboundContactOutcomeRecallTypeId: string; contactOutcomePolicyDigest: string; rateBudget: ClinikoRequestBudget; clock?: () => string; deadlineMs?: number }>;
type Selection = Readonly<{ scope: LocationScope; businessId: string; credentialFingerprint: string;
  outboundContactOutcomeRecallTypeId: string; contactOutcomePolicyDigest: string }>;
export type OutboundContactOutcomeQuery = Selection & Readonly<{ ownerBinding: string; operation: "retainContactOutcome" | "readContactOutcome";
  actionRef: string; patientId: string; recallRef?: string; recallAt?: string; includeArchived?: true; outcome?: OutboundContactOutcome; outcomeDigest?: string }>;
export type OutboundContactOutcomeReadAuthority = NativeOutboundReadAuthority<OutboundContactOutcomeQuery>;
export type OutboundContactOutcomeWriteAuthority = OutboundContactOutcomeReadAuthority & Readonly<{ producerAdmitted(query: OutboundContactOutcomeQuery, signal: AbortSignal): Promise<boolean> }>;
export type OutboundContactOutcomeHistoryQuery = Selection & Readonly<{ ownerBinding: string; operation: "readContactOutcomeHistory";
  attempt: OutboundLaunchRecord; includeArchived: true; includeClosed: true }>;
export type OutboundContactOutcomeHistoryAuthority = Readonly<{
  allowsHistoryRead(query: OutboundContactOutcomeHistoryQuery, signal: AbortSignal): Promise<boolean>;
  allowsRecordRead(query: OutboundContactOutcomeQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundContactOutcomeHistoryQuery | OutboundContactOutcomeQuery, signal: AbortSignal): boolean;
}>;
export type OutboundContactOutcomeRecord = Readonly<{ kind: "nativeContactOutcome"; recallRef: string; outcome: OutboundContactOutcome;
  recallAt: string; createdAt: string; updatedAt: string; recalled: boolean; recalledAt: string | null; archivedAt: string | null }>;
function selection(c: OutboundContactOutcomeConfig): Selection {
  return Object.freeze({ scope: Object.freeze({ ...c.scope }), businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey),
    outboundContactOutcomeRecallTypeId: c.outboundContactOutcomeRecallTypeId, contactOutcomePolicyDigest: c.contactOutcomePolicyDigest });
}
function shard(c: OutboundContactOutcomeConfig, port: typeof fetch): string | undefined {
  return outboundConfigShard({ ...c, outboundRecallTypeId: c.outboundContactOutcomeRecallTypeId, recordPolicyDigest: c.contactOutcomePolicyDigest }, port);
}
export function outboundContactOutcomeRecordBinding(c: OutboundContactOutcomeConfig): string | undefined {
  try { if (!shard(c, fetch)) return undefined; const s=selection(c);
    return createHash("sha256").update(JSON.stringify(["abby.outbound-contact-outcome-record.v1",s.scope.tenantId,s.scope.clinicId,s.scope.locationId,s.businessId,s.credentialFingerprint,s.outboundContactOutcomeRecallTypeId,s.contactOutcomePolicyDigest])).digest("hex");
  } catch { return undefined; }
}
/** A separate clinic-owned native family and one-use action. Exact ACK establishes
 * retained evidence only; this adapter never releases contact or call capacity. */
export class ClinikoOutboundContactOutcomeRecords {
  readonly #records: NativeOutboundRecords<OutboundContactOutcome, OutboundContactOutcomeQuery>;
  private constructor(c: OutboundContactOutcomeConfig, sourceShard: string, owner: string, authority: OutboundContactOutcomeReadAuthority, port: typeof fetch,
    write?: Readonly<{ authority: OutboundContactOutcomeWriteAuthority; effects: OutboundEffectBarrier }>) {
    const s=selection(c);
    this.#records=new NativeOutboundRecords({ ...c, scope:s.scope, credentialFingerprint:s.credentialFingerprint, typeId:s.outboundContactOutcomeRecallTypeId },sourceShard,owner,authority,port,
      {encode:encodeOutboundContactOutcome,decode:decodeOutboundContactOutcome,recordedAt:v=>v.recordedAt,expiresAt:()=>"9999-12-31T23:59:59.999Z"},
      q=>Object.freeze({...s,ownerBinding:owner,operation:q.method==="POST"?"retainContactOutcome":"readContactOutcome",actionRef:q.actionRef,patientId:q.patientId,
        ...(q.method==="GET"?{includeArchived:true as const}:{}),...(q.recallRef?{recallRef:q.recallRef}:{}),...(q.recallAt?{recallAt:q.recallAt}:{}),
        ...(q.record?{outcome:q.record,outcomeDigest:outboundContactOutcomeDigest(q.record)!}:{})}),
      write?{barrier:write.effects,producer:write.authority.producerAdmitted.bind(write.authority)}:undefined);
  }
  static create(c: OutboundContactOutcomeConfig, authority: OutboundContactOutcomeWriteAuthority, effects: OutboundEffectBarrier, port: typeof fetch=fetch): Result<ClinikoOutboundContactOutcomeRecords,NativeOutboundFailure> {
    try {const s=shard(c,port),owner=outboundContactOutcomeRecordBinding(c);
      if(!s||!owner||[authority?.allows,authority?.current,authority?.producerAdmitted,effects?.matches,effects?.claimOnce].some(f=>typeof f!=="function")||effects.matches(c.scope,owner)!==true)return err({kind:"invalidConfig"});
      return ok(new ClinikoOutboundContactOutcomeRecords(c,s,owner,authority,port,{authority,effects}));
    }catch{return err({kind:"invalidConfig"});}
  }
  static createReadOnly(c: OutboundContactOutcomeConfig, authority: OutboundContactOutcomeReadAuthority, port: typeof fetch=fetch): Result<Pick<ClinikoOutboundContactOutcomeRecords,"readOutcome">,NativeOutboundFailure> {
    try{const s=shard(c,port),owner=outboundContactOutcomeRecordBinding(c);if(!s||!owner||[authority?.allows,authority?.current].some(f=>typeof f!=="function"))return err({kind:"invalidConfig"});
      const records=new ClinikoOutboundContactOutcomeRecords(c,s,owner,authority,port);return ok(Object.freeze({readOutcome:records.readOutcome.bind(records)}));}catch{return err({kind:"invalidConfig"});}
  }
  retainOutcomeOnce(outcome: OutboundContactOutcome, recallAt: string, signal: AbortSignal): Promise<Result<NativeOutboundRetention,NativeOutboundFailure>> {
    return this.#records.retain(outcome,recallAt,signal);
  }
  async readOutcome(binding: NativeOutboundReadBinding, signal: AbortSignal): Promise<Result<OutboundContactOutcomeRecord,NativeOutboundFailure>> {
    const r=await this.#records.read(binding,signal);if(!r.ok)return r;const {record,...rest}=r.value;
    return ok(Object.freeze({...rest,kind:"nativeContactOutcome",outcome:record}));
  }
}
class Refusal extends Error {readonly kind:NativeOutboundFailure["kind"];constructor(kind:NativeOutboundFailure["kind"]){super("Native contact outcome unavailable");this.kind=kind;}}
const discard=(r:Response|undefined)=>{try{void r?.body?.cancel().catch(()=>{});}catch{/* Owned response only. */}};
/** Complete bounded patient history and exact rereads recover a preallocated
 * outcome after ACK/process loss. Absence never resets its one-use action. */
export class ClinikoOutboundContactOutcomeHistory {
  readonly #config:OutboundContactOutcomeConfig;readonly #authority:OutboundContactOutcomeHistoryAuthority;readonly #port:typeof fetch;readonly #base:string;readonly #owner:string;
  private constructor(c:OutboundContactOutcomeConfig,a:OutboundContactOutcomeHistoryAuthority,port:typeof fetch,s:string,owner:string){
    this.#config=Object.freeze({...c,scope:Object.freeze({...c.scope}),...(c.clock?{clock:c.clock.bind(c)}:{}),rateBudget:Object.freeze({claim:c.rateBudget.claim.bind(c.rateBudget),observe429:c.rateBudget.observe429.bind(c.rateBudget)})});
    this.#authority=Object.freeze({allowsHistoryRead:a.allowsHistoryRead.bind(a),allowsRecordRead:a.allowsRecordRead.bind(a),current:a.current.bind(a)});this.#port=port;this.#base=`https://api.${s}.cliniko.com/v1`;this.#owner=owner;
  }
  static create(c:OutboundContactOutcomeConfig,a:OutboundContactOutcomeHistoryAuthority,port:typeof fetch=fetch):Result<ClinikoOutboundContactOutcomeHistory,NativeOutboundFailure>{
    try{const s=shard(c,port),owner=outboundContactOutcomeRecordBinding(c);if(!s||!owner||[a?.allowsHistoryRead,a?.allowsRecordRead,a?.current].some(f=>typeof f!=="function"))return err({kind:"invalidConfig"});return ok(new ClinikoOutboundContactOutcomeHistory(c,a,port,s,owner));}catch{return err({kind:"invalidConfig"});}
  }
  async findForAttempt(input:OutboundLaunchRecord,external:AbortSignal):Promise<Result<Readonly<{kind:"nativeContactOutcomeHistory";selected:number;scanned:number;record?:OutboundContactOutcomeRecord}>,NativeOutboundFailure>>{
    if(!(external instanceof AbortSignal)||external.aborted)return err({kind:"unavailable"});
    let attempt:OutboundLaunchRecord;
    try{const raw=structuredClone(input),encoded=encodeOutboundLaunchAttempt(raw.attempt);
      if(!encoded.ok)return err({kind:"invalidQuery"});const decoded=decodeOutboundLaunchAttempt(encoded.value);if(!decoded.ok)return err({kind:"invalidQuery"});
      if(Object.keys(raw).sort().join(",")!=="archivedAt,attempt,createdAt,kind,recallAt,recallRef,recalled,recalledAt,updatedAt"||raw.kind!=="possibleLaunchContext")return err({kind:"invalidQuery"});
      attempt=Object.freeze({...raw,attempt:decoded.value});const a=attempt.attempt,s=selection(this.#config);
      if(!a.contactReferences||!outboundLaunchAttemptDigest(a)||!/^cliniko:recall:[1-9][0-9]{0,18}$/.test(attempt.recallRef)||
        !isDeepStrictEqual(a.scope,s.scope)||a.businessId!==s.businessId||a.credentialFingerprint!==s.credentialFingerprint)return err({kind:"invalidQuery"});
    }catch{return err({kind:"invalidQuery"});}
    const c=this.#config,controller=new AbortController(),ms=c.deadlineMs??15000,timer=setTimeout(()=>controller.abort(),ms),signal=AbortSignal.any([external,controller.signal]),began=performance.now();let last="";
    const q=Object.freeze({...selection(c),ownerBinding:this.#owner,operation:"readContactOutcomeHistory" as const,attempt,includeArchived:true as const,includeClosed:true as const});
    const grants=new Map<string,OutboundContactOutcomeQuery>();
    const now=()=>{const at=c.clock?.()??new Date().toISOString();if(signal.aborted||performance.now()-began>ms||outboundNativeInstant(at)!==at||at<last)throw new Refusal("unavailable");last=at;return at;};
    const wait=async<T>(p:Promise<T>):Promise<T>=>{const v=await awaitUntilAbort(p,signal);if(v===undefined)throw new Refusal("unavailable");now();return v;};
    const current=(query:OutboundContactOutcomeHistoryQuery|OutboundContactOutcomeQuery)=>{now();if(this.#authority.current(query,signal)!==true)throw new Refusal("forbidden");now();};
    const permit=async()=>{current(q);if(await wait(this.#authority.allowsHistoryRead(q,signal))!==true)throw new Refusal("forbidden");current(q);};
    try{
      now();const scan=()=>readPatientRecallHistory({base:this.#base,patientId:attempt.attempt.patientId,typeId:c.outboundContactOutcomeRecallTypeId},async url=>{
        await permit();const limited=await wait(claimClinikoBudget(c.rateBudget));if(limited)throw new Refusal(limited.kind);await permit();let response:Response|undefined,owned=false;
        try{current(q);const found=await wait(this.#port(url,{method:"GET",redirect:"error",signal,headers:{Accept:"application/json",Authorization:`Basic ${Buffer.from(`${c.apiKey}:`).toString("base64")}`,"User-Agent":`Abby (${c.contactEmail})`}}).then(r=>{response=r;if(signal.aborted)discard(r);return r;}));
          if(found.status===429){await wait(observeCliniko429(c.rateBudget,found.headers.get("X-RateLimit-Reset")));throw new Refusal("rateLimited");}
          if(found.status===401||found.status===403)throw new Refusal("forbidden");if(found.status!==200)throw new Refusal("unavailable");owned=true;const bytes=await wait(ownedBodyBytes(found.body,1000000,signal));let raw:unknown;
          try{raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new Refusal("malformed");}await permit();return raw;
        }finally{if(!owned)discard(response);}
      },now);
      const history=await scan(),actions=new Set<string>();let result:OutboundContactOutcomeRecord|undefined;
      const reader=ClinikoOutboundContactOutcomeRecords.createReadOnly(c,{allows:async(g,s)=>{await permit();current(g);if(await wait(this.#authority.allowsRecordRead(g,s))!==true)return false;current(g);if(g.outcome||!grants.get(g.recallRef!))grants.set(g.recallRef!,g);return true;},current:g=>{try{current(q);current(g);return true;}catch{return false;}}},this.#port);
      if(!reader.ok)return reader;
      for(const row of history.rows){const decoded=decodeOutboundContactOutcome(row.notes);if(!decoded.ok)throw new Refusal("malformed");const o=decoded.value;
        if(actions.has(o.actionRef))throw new Refusal("mismatched");actions.add(o.actionRef);
        const found=await wait(reader.value.readOutcome({recallRef:`cliniko:recall:${row.id}`,actionRef:o.actionRef,patientId:row.patientId},signal));if(!found.ok)return found;
        const native=found.value;if(outboundContactOutcomeDigest(native.outcome)!==outboundContactOutcomeDigest(o)||native.recallAt!==row.recallAt||native.createdAt!==row.createdAt||native.updatedAt!==row.updatedAt||native.recalled!==row.recalled||native.recalledAt!==row.recalledAt||native.archivedAt!==row.archivedAt)throw new Refusal("mismatched");
        if(o.actionRef===attempt.attempt.contactReferences!.outcomeActionRef||o.attempt.actionRef===attempt.attempt.actionRef||o.attempt.recallRef===attempt.recallRef){
          if(result||!outboundContactOutcomeMatchesAttempt(o,attempt))throw new Refusal("mismatched");result=native;
        }
      }
      await permit();if(!isDeepStrictEqual(await scan(),history))throw new Refusal("mismatched");await permit();for(const g of grants.values())current(g);current(q);
      return ok(Object.freeze({kind:"nativeContactOutcomeHistory",selected:history.rows.length,scanned:history.scanned,...(result?{record:result}:{})}));
    }catch(e){return err({kind:e instanceof Refusal||e instanceof OwnedBodyError||e instanceof PatientRecallHistoryError?e.kind:"unavailable"});}finally{clearTimeout(timer);controller.abort();}
  }
}
