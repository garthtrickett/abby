import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { outboundContactGuardOwnerBinding } from "../core/outbound-capacity.ts";
import type { OutboundCapacity } from "../core/outbound-capacity.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { validOutboundEffectScope } from "../portability/outbound-effect-history.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { checkClinikoHeadroom } from "../cliniko/read-budget.ts";
import { contactSourceSelection, contactSourceBinding } from "../cliniko/internal/outbound-contact-source-context.ts";
import { ClinikoOutboundLaunchRecords } from "../cliniko/outbound-launch-records.ts";
import { outboundLaunchAttemptDigest } from "../cliniko/outbound-launch-attempt.ts";
import type { OutboundLaunchRecord } from "../cliniko/outbound-launch-records.ts";
import type { NativeOutboundReadBinding } from "../cliniko/internal/outbound-native-record.ts";
import { ClinikoOutboundDncRecords } from "../cliniko/outbound-dnc-records.ts";
import { outboundContactReviewDigest } from "../cliniko/outbound-contact-review.ts";
import { ClinikoOutboundContactOutcomeRecords, ClinikoOutboundContactOutcomeHistory } from "../cliniko/outbound-contact-outcome-records.ts";
import type { OutboundContactOutcomeConfig, OutboundContactOutcomeWriteAuthority, OutboundContactOutcomeHistoryAuthority, OutboundContactOutcomeRecord } from "../cliniko/outbound-contact-outcome-records.ts";
import { outboundContactOutcomeMatchesAttempt, outboundContactOutcomeDigest } from "../cliniko/outbound-contact-outcome.ts";
import type { OutboundContactOutcome } from "../cliniko/outbound-contact-outcome.ts";
import type { OutboundTerminalProvider, OutboundRuntimeTerminalResult } from "../voice/outbound-runtime.ts";
import { ClinikoOutboundStopOwner } from "./cliniko-outbound-stop-owner.ts";
import type { OutboundStopOwnerConfig, OutboundStopObservation } from "./cliniko-outbound-stop-owner.ts";
import { OwnerFileOutboundContactAccount } from "./owner-file-outbound-contact-account.ts";

type ProviderBinding = ReturnType<OutboundTerminalProvider["binding"]>;
/** Complete final contact semantics for ALL calls of this exact pair. The trusted
 * adapter owns authentication, final speech/report closure, durable lookup and
 * immutable original SEND-context digest and report digest/time. The attempt
 * digest must never be reconstructed from currently editable native notes.
 * Missing callbacks or a summary are not complete. */
export type OutboundCompleteContactReport = Readonly<{ kind: "complete"; complete: true; effectRef: string; capacityAllocationRef: string;
  provider: ProviderBinding; attemptDigest: string; reportDigest: string; reportedAt: string }> & (
  Readonly<{ contact: "noStopRequested" }> | Readonly<{ contact: "stopRequested"; stop: OutboundStopObservation }>);
export type OutboundContactSettlementProvider = OutboundTerminalProvider & Readonly<{
  inspectContact(identity: Readonly<{ effectRef: string; capacityAllocationRef: string }>, signal: AbortSignal):
    Promise<OutboundCompleteContactReport | Readonly<{ kind: "unknown" | "pending" }>>;
}>;
export type OutboundContactSettlementQuery = Readonly<{ operation: "approveNativeSource" | "readProviderContactOutcome" | "readProviderTerminal" | "retainNativeContactOutcome" | "releaseContactHold";
  attempt: OutboundLaunchRecord; provider: ProviderBinding; guardRef: string; guardOwner: string; capacityScope: LocationScope; accountBinding: string;
  report?: OutboundCompleteContactReport; terminal?: Extract<OutboundRuntimeTerminalResult,{kind:"terminal"}>; outcome?: OutboundContactOutcome }>;
export type OutboundContactSettlementAuthority = Readonly<{ allows(query: OutboundContactSettlementQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundContactSettlementQuery, signal: AbortSignal): boolean }>;
export type OutboundContactSettlementConfig = Readonly<{ stop: OutboundStopOwnerConfig; outcomes: OutboundContactOutcomeConfig;
  account: OwnerFileOutboundContactAccount; guardRef: string; capacityScope: LocationScope; maximumNativeRequests: number; deadlineMs?: number }>;
type StopPorts = Omit<Parameters<typeof ClinikoOutboundStopOwner.create>[1],"provider"|"native">;
type Ports = Readonly<{ stop: StopPorts; outcomes: OutboundContactOutcomeWriteAuthority; history: OutboundContactOutcomeHistoryAuthority;
  outcomeEffects: OutboundEffectBarrier; provider: OutboundContactSettlementProvider; authority: OutboundContactSettlementAuthority;
  capacity: Pick<OutboundCapacity,"matches"|"releaseOnce">; native?: typeof fetch }>;
type Failure = Readonly<{kind:"invalidConfig"|"unavailable"|"forbidden"|"unrecoverable"}>;
export type OutboundContactSettlementResult = Readonly<{kind:"held"}> | Readonly<{kind:"nativeContactOutcomeRetained";recallRef:string;contactHold:"released"|"releaseUnconfirmed"}>;
const exact=(v:unknown,keys:readonly string[])=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")===[...keys].sort().join(",");
const instant=(v:unknown):v is string=>typeof v==="string"&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const bindingValid=(v:ProviderBinding)=>exact(v,["ref","bindingDigest"])&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v.ref)&&/^[a-f0-9]{64}$/.test(v.bindingDigest);
function capture<T extends object>(value:T,keys:readonly(keyof T)[]):Readonly<T>{
  const result={...value};for(const key of keys){const f=value[key];if(typeof f!=="function")throw Error("Unavailable port");result[key]=f.bind(value);}return Object.freeze(result);
}
/** Native retention before guarded contact release. Call concurrency and all
 * permanent effects retain their separate owners. No dial/clinical route. */
export class ClinikoOutboundContactSettlement {
  readonly #config:OutboundContactSettlementConfig;readonly #ports:Ports;readonly #guardOwner:string;
  readonly #accountCurrent:OwnerFileOutboundContactAccount["current"];readonly #accountMethods:readonly unknown[];readonly #accountBinding:string;readonly #policyMethod:unknown;
  private constructor(c:OutboundContactSettlementConfig,p:Ports,owner:string){
    this.#config=c;this.#ports=p;this.#guardOwner=owner;this.#accountCurrent=c.account.current.bind(c.account);
    this.#accountMethods=Object.freeze([c.account.current,c.account.matches,c.account.bindingFingerprint]);this.#accountBinding=c.account.bindingFingerprint();this.#policyMethod=c.stop.policy.currentFor;
  }
  static create(input:OutboundContactSettlementConfig,incoming:Ports):Result<ClinikoOutboundContactSettlement,Failure>{
    try{
      const guard=outboundContactGuardOwnerBinding(input.guardRef),ms=input.deadlineMs??60000;
      if(!guard||!validOutboundEffectScope(input.capacityScope)||!(input.account instanceof OwnerFileOutboundContactAccount)||
        !Number.isSafeInteger(input.maximumNativeRequests)||input.maximumNativeRequests<input.stop.maximumNativeRequests+10||input.maximumNativeRequests>180||!Number.isSafeInteger(ms)||ms<1||ms>120000||
        incoming.capacity.matches(input.capacityScope,guard)!==true)return err({kind:"invalidConfig"});
      const base=input.stop.requests;
      for(const c of [input.stop.attempts,input.stop.dnc.source,input.outcomes])if(!isDeepStrictEqual(c.scope,base.scope)||c.apiKey!==base.apiKey||c.businessId!==base.businessId||c.rateBudget!==base.rateBudget)return err({kind:"invalidConfig"});
      if(new Set([base.outboundRecallTypeId,input.stop.attempts.outboundAttemptRecallTypeId,input.stop.dnc.source.contactReviewRecallTypeId,input.outcomes.outboundContactOutcomeRecallTypeId]).size!==4)return err({kind:"invalidConfig"});
      const p=Object.freeze({...incoming,provider:capture(incoming.provider,["binding","inspectContact","inspectTerminal"]),authority:capture(incoming.authority,["allows","current"]),
        capacity:capture(incoming.capacity,["matches","releaseOnce"]),outcomes:capture(incoming.outcomes,["allows","current","producerAdmitted"]),history:capture(incoming.history,["allowsHistoryRead","allowsRecordRead","current"]),
        outcomeEffects:capture(incoming.outcomeEffects,["matches","claimOnce"]),stop:Object.freeze({...incoming.stop,request:capture(incoming.stop.request,["allows","current"]),attempt:capture(incoming.stop.attempt,["allows","current"]),
          contact:capture(incoming.stop.contact,["allows","current"]),definition:capture(incoming.stop.definition,["currentFor"]),record:capture(incoming.stop.record,["allows","current","producerAdmitted"]),
          authority:capture(incoming.stop.authority,["allows","current"]),effects:capture(incoming.stop.effects,["matches","claimOnce"])})});
      const physical=base.rateBudget,budget=Object.freeze({claim:physical.claim.bind(physical),observe429:physical.observe429.bind(physical),...(physical.checkHeadroom?{checkHeadroom:physical.checkHeadroom.bind(physical)}:{})});
      const nativeConfig=<T extends {scope:LocationScope;rateBudget:typeof physical;clock?:()=>string}>(v:T)=>Object.freeze({...v,scope:Object.freeze({...v.scope}),rateBudget:budget,...(v.clock?{clock:v.clock.bind(v)}:{})});
      const c=Object.freeze({...input,capacityScope:Object.freeze({...input.capacityScope}),outcomes:nativeConfig(input.outcomes),stop:Object.freeze({...input.stop,
        requests:nativeConfig(input.stop.requests),attempts:nativeConfig(input.stop.attempts),dnc:Object.freeze({...input.stop.dnc,source:nativeConfig(input.stop.dnc.source)})})});
      const stop=ClinikoOutboundStopOwner.create(c.stop,{...p.stop,...(p.native?{native:p.native}:{}),provider:{binding:p.provider.binding,inspectStop:async()=>({kind:"unknown"})}});
      if(!stop.ok||!ClinikoOutboundContactOutcomeRecords.create(c.outcomes,p.outcomes,p.outcomeEffects,p.native).ok||!ClinikoOutboundContactOutcomeHistory.create(c.outcomes,p.history,p.native).ok)return err({kind:"invalidConfig"});
      return ok(new ClinikoOutboundContactSettlement(c,p,guard));
    }catch{return err({kind:"invalidConfig"});}
  }
  async settleOnce(input:NativeOutboundReadBinding,external:AbortSignal):Promise<Result<OutboundContactSettlementResult,Failure>>{
    if(!(external instanceof AbortSignal)||external.aborted)return err({kind:"unavailable"});
    let selected:NativeOutboundReadBinding;try{selected=Object.freeze(structuredClone(input));}catch{return err({kind:"unavailable"});}
    const c=this.#config,p=this.#ports,ms=c.deadlineMs??60000,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms),signal=AbortSignal.any([external,controller.signal]),began=performance.now();
    let last="",q:OutboundContactSettlementQuery|undefined,known:string|undefined,releaseKnown=false;
    const grants=new Map<OutboundContactSettlementQuery["operation"],OutboundContactSettlementQuery>(),nativeGrants=new Map<string,()=>boolean>();
    const now=()=>{const at=c.stop.attempts.clock?.()??new Date().toISOString();if(signal.aborted||performance.now()-began>ms||!instant(at)||at<last)throw Error("Unavailable time");last=at;return at;};
    const wait=async<T>(task:Promise<T>):Promise<T>=>{const v=await awaitUntilAbort(task,signal);if(v===undefined)throw Error("Unavailable operation");now();return v;};
    const current=()=>{now();if(!q||!p.capacity.matches(c.capacityScope,this.#guardOwner)||!isDeepStrictEqual(p.provider.binding(),q.provider)||
      ![c.account.current,c.account.matches,c.account.bindingFingerprint].every((v,i)=>v===this.#accountMethods[i])||c.stop.policy.currentFor!==this.#policyMethod||
      [...grants.values()].some(g=>p.authority.current(g,signal)!==true)||[...nativeGrants.values()].some(check=>check()!==true))throw Error("Permission unavailable");};
    const authorize=async(...operations:OutboundContactSettlementQuery["operation"][])=>{for(const operation of operations){current();const query=Object.freeze({...q!,operation});
      if(await wait(p.authority.allows(query,signal))!==true||p.authority.current(query,signal)!==true)throw Error("Permission unavailable");grants.set(operation,query);current();}};
    const account=async()=>{const found=await wait(this.#accountCurrent(signal));if(!found.ok||!found.value||found.value.account.contactGuardRef!==c.guardRef||
      !found.value.account.sources.some(s=>contactSourceBinding(s)===contactSourceBinding(contactSourceSelection(c.stop.dnc.source))))throw Error("Account source unavailable");};
    const outcomeKnown=()=>ok({kind:"nativeContactOutcomeRetained" as const,recallRef:known!,contactHold:releaseKnown?"released" as const:"releaseUnconfirmed" as const});
    try{
      now();if(await wait(checkClinikoHeadroom(c.stop.requests.rateBudget,c.maximumNativeRequests))!==null)return err({kind:"unavailable"});
      if(![c.account.current,c.account.matches,c.account.bindingFingerprint].every((v,i)=>v===this.#accountMethods[i])||c.stop.policy.currentFor!==this.#policyMethod)return err({kind:"forbidden"});
      await account();
      const reader=ClinikoOutboundLaunchRecords.createReadOnly(c.stop.attempts,{allows:p.stop.attempt.allows,current:(g,s)=>{if(g.attempt||!nativeGrants.has("attempt"))nativeGrants.set("attempt",()=>p.stop.attempt.current(g,signal));return p.stop.attempt.current(g,s);}},p.native);
      if(!reader.ok)return err({kind:"unavailable"});const read=await wait(reader.value.readPossibleAttempt(selected,signal));if(!read.ok)return err({kind:"unavailable"});
      const a=read.value.attempt,provider=Object.freeze({...p.provider.binding()});
      if(!a.contactReferences||!a.dncReferences||!a.capacityAllocationRef)return err({kind:"unrecoverable"});
      if(a.contactReferences.guardRef!==c.guardRef||!bindingValid(provider)||!isDeepStrictEqual(provider,a.provider))return err({kind:"forbidden"});
      q=Object.freeze({operation:"approveNativeSource",attempt:read.value,provider,guardRef:c.guardRef,guardOwner:this.#guardOwner,capacityScope:c.capacityScope,accountBinding:this.#accountBinding});
      await authorize("approveNativeSource","readProviderContactOutcome","readProviderTerminal");
      const identity=Object.freeze({effectRef:a.effectRef,capacityAllocationRef:a.capacityAllocationRef});
      const inspect=async()=>{
        const report=structuredClone(await wait(p.provider.inspectContact(identity,signal)));current();
        if(report.kind!=="complete")return undefined;
        const keys=["kind","complete","effectRef","capacityAllocationRef","provider","attemptDigest","reportDigest","reportedAt","contact",...(report.contact==="stopRequested"?["stop"]:[])];
        if(!exact(report,keys)||report.complete!==true||report.effectRef!==a.effectRef||report.capacityAllocationRef!==a.capacityAllocationRef||!isDeepStrictEqual(report.provider,provider)||
          report.attemptDigest!==outboundLaunchAttemptDigest(a)||!/^[a-f0-9]{64}$/.test(report.reportDigest)||!instant(report.reportedAt)||report.reportedAt<a.attemptedAt||report.reportedAt>now()||!["noStopRequested","stopRequested"].includes(report.contact))throw Error("Incomplete contact report");
        if(report.contact==="stopRequested"){const s=report.stop;
          if(!exact(s,["kind","effectRef","capacityAllocationRef","provider","number","participant","stoppedAt","observedAt"])||s.kind!=="stop"||s.effectRef!==a.effectRef||s.capacityAllocationRef!==a.capacityAllocationRef||!isDeepStrictEqual(s.provider,provider)||
            s.participant!=="anyAtDialledNumber"||!/^\+[1-9][0-9]{7,14}$/.test(s.number)||!instant(s.stoppedAt)||!instant(s.observedAt)||s.stoppedAt<a.attemptedAt||s.stoppedAt>s.observedAt||s.observedAt>report.reportedAt)throw Error("Unmatched stop");
        }
        const terminal=structuredClone(await wait(p.provider.inspectTerminal(identity,signal)));current();
        if(terminal.kind!=="terminal")return undefined;
        if(!exact(terminal,["kind","complete","effectRef","capacityAllocationRef","provider","endedAt","observedAt"])||terminal.complete!==true||terminal.effectRef!==a.effectRef||terminal.capacityAllocationRef!==a.capacityAllocationRef||!isDeepStrictEqual(terminal.provider,provider)||
          !instant(terminal.endedAt)||!instant(terminal.observedAt)||terminal.endedAt<a.attemptedAt||terminal.endedAt>terminal.observedAt||terminal.observedAt>now()||terminal.endedAt>report.reportedAt)throw Error("Unmatched terminal");
        return Object.freeze({report:Object.freeze({...report,provider,...(report.contact==="stopRequested"?{stop:Object.freeze({...report.stop,provider})}:{})}),terminal:Object.freeze({...terminal,provider})});
      };
      const observed=await inspect();if(!observed)return ok({kind:"held"});
      q=Object.freeze({...q,report:observed.report,terminal:observed.terminal});await authorize("approveNativeSource","readProviderContactOutcome","readProviderTerminal");
      const history=ClinikoOutboundContactOutcomeHistory.create(c.outcomes,{allowsHistoryRead:p.history.allowsHistoryRead,allowsRecordRead:p.history.allowsRecordRead,current:(g,s)=>{
        const key=g.operation==="readContactOutcomeHistory"?"outcomeHistory":"outcome:"+g.recallRef; if(g.operation==="readContactOutcomeHistory"||g.outcome||!nativeGrants.has(key))nativeGrants.set(key,()=>p.history.current(g,signal));return p.history.current(g,s);}},p.native);
      if(!history.ok)return err({kind:"unavailable"});let found=await wait(history.value.findForAttempt(read.value,signal));if(!found.ok)return err({kind:"unavailable"});
      if(!found.value.record&&(found.value.selected>=50||found.value.scanned>=500))return ok({kind:"held"});
      const pages=(count:number)=>Math.max(1,Math.ceil(count/100));
      // Admit this exact current workload before either new native mutation.
      // Actual claims still enforce180 under concurrent growth; no reservation.
      const cost=2+found.value.selected+2*pages(found.value.scanned)+
        (found.value.record?0:1+found.value.selected+1+2*pages(found.value.scanned+1))+
        (observed.report.contact==="stopRequested"?c.stop.maximumNativeRequests+1:0);
      if(cost>c.maximumNativeRequests||cost>180)return ok({kind:"held"});
      let decision:Extract<OutboundContactOutcome["result"],{kind:"stopRetained"}>["decision"]|undefined;
      if(observed.report.contact==="stopRequested"){
        const stop=ClinikoOutboundStopOwner.create(c.stop,{...p.stop,...(p.native?{native:p.native}:{}),provider:{binding:p.provider.binding,inspectStop:async pair=>{
          current();return isDeepStrictEqual(pair,identity)?observed.report.contact==="stopRequested"?observed.report.stop:{kind:"unknown"}:{kind:"unknown"};}}});
        if(!stop.ok)return err({kind:"unavailable"});const result=await wait(stop.value.retainStopOnce(selected,signal));
        if(!result.ok||result.value.kind!=="accepted"&&result.value.kind!=="existingDecision")return ok({kind:"held"});
        const dnc=ClinikoOutboundDncRecords.createReadOnly(c.stop.dnc,p.stop.definition,{allows:p.stop.record.allows,current:(g,s)=>{if(g.review||!nativeGrants.has("dnc"))nativeGrants.set("dnc",()=>p.stop.record.current(g,signal));return p.stop.record.current(g,s);}},p.native);
        if(!dnc.ok)return err({kind:"unavailable"});const saved=await wait(dnc.value.readDecision({recallRef:result.value.recallRef,actionRef:a.dncReferences.actionRef,patientId:a.patientId},signal));
        if(!saved.ok||saved.value.record.approvalRef!==a.dncReferences.approvalRef||saved.value.record.recipient.number!==observed.report.stop.number||saved.value.record.purposes.join(",")!=="followUp,sickDay")return ok({kind:"held"});
        decision=Object.freeze({recallRef:saved.value.recallRef,actionRef:saved.value.record.actionRef,digest:outboundContactReviewDigest(saved.value.record)!});
      }
      if(found.value.record){const o=found.value.record.outcome;
        if(o.result.reportDigest!==observed.report.reportDigest||o.reportedAt!==observed.report.reportedAt||o.terminal.endedAt!==observed.terminal.endedAt||
          (observed.report.contact==="noStopRequested"?o.result.kind!=="completeNoStop":o.result.kind!=="stopRetained"||!isDeepStrictEqual(o.result.decision,decision)))return err({kind:"unrecoverable"});
        known=found.value.record.recallRef;
      }else{
        const outcome:OutboundContactOutcome=Object.freeze({actionRef:a.contactReferences.outcomeActionRef,scope:a.scope,businessId:a.businessId,credentialFingerprint:a.credentialFingerprint,patientId:a.patientId,
          attempt:Object.freeze({recallRef:read.value.recallRef,actionRef:a.actionRef,digest:outboundLaunchAttemptDigest(a)!}),result:decision?Object.freeze({kind:"stopRetained" as const,reportDigest:observed.report.reportDigest,decision}):Object.freeze({kind:"completeNoStop" as const,reportDigest:observed.report.reportDigest}),
          terminal:Object.freeze({endedAt:observed.terminal.endedAt,observedAt:observed.terminal.observedAt}),reportedAt:observed.report.reportedAt,recordedAt:now()});
        if(!outboundContactOutcomeMatchesAttempt(outcome,read.value))return err({kind:"unrecoverable"});q=Object.freeze({...q,outcome});await authorize("retainNativeContactOutcome");await account();
        const records=ClinikoOutboundContactOutcomeRecords.create(c.outcomes,{allows:async(g,s)=>{await authorize("retainNativeContactOutcome");return p.outcomes.allows(g,s);},current:(g,s)=>{try{current();if(g.outcome||!nativeGrants.has("outcomeWrite"))nativeGrants.set("outcomeWrite",()=>p.outcomes.current(g,signal));return p.outcomes.current(g,s);}catch{return false;}},producerAdmitted:p.outcomes.producerAdmitted},p.outcomeEffects,p.native);
        if(!records.ok)return err({kind:"unavailable"});const retained=await wait(records.value.retainOutcomeOnce(outcome,read.value.recallAt,signal).then(r=>{if(r.ok&&r.value.kind==="accepted")known=r.value.recallRef;return r;}));
        if(!retained.ok||retained.value.kind!=="accepted")return ok({kind:"held"});
        found=await wait(history.value.findForAttempt(read.value,signal));if(!found.ok||!found.value.record||found.value.record.recallRef!==known||outboundContactOutcomeDigest(found.value.record.outcome)!==outboundContactOutcomeDigest(outcome))return outcomeKnown();
      }
      const settled=found.value.record;if(!settled)return outcomeKnown();q=Object.freeze({...q,outcome:settled.outcome});
      const fresh=await wait(reader.value.readPossibleAttempt(selected,signal));if(!fresh.ok||!isDeepStrictEqual(fresh.value,read.value))return outcomeKnown();
      const again=await inspect();if(!again||!isDeepStrictEqual(again.report,observed.report)||again.terminal.endedAt!==observed.terminal.endedAt)return outcomeKnown();
      await account();await authorize("approveNativeSource","readProviderContactOutcome","readProviderTerminal","releaseContactHold");current();
      const released=await wait(p.capacity.releaseOnce(a.contactReferences.allocationRef,()=>{try{current();return true;}catch{return false;}}).then(r=>{if(r.ok)releaseKnown=true;return r;}));
      return released.ok?ok({kind:"nativeContactOutcomeRetained",recallRef:known!,contactHold:"released"}):outcomeKnown();
    }catch{return known?outcomeKnown():err({kind:"unavailable"});}finally{clearTimeout(timer);controller.abort();}
  }
}
