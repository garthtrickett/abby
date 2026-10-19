import assert from "node:assert/strict";
import { outboundStopOwnerFixture } from "./outbound-stop-owner.ts";
import { outboundContactLifecycleFixture } from "./outbound-contact-lifecycle.ts";
import { value } from "./outbound-records.ts";
import { ClinikoOutboundContactSettlement } from "../../src/standalone/cliniko-outbound-contact-settlement.ts";
import type { OutboundContactSettlementQuery, OutboundContactSettlementProvider, OutboundCompleteContactReport } from "../../src/standalone/cliniko-outbound-contact-settlement.ts";
import { ClinikoOutboundStopOwner } from "../../src/standalone/cliniko-outbound-stop-owner.ts";
import { OwnerFileOutboundDncPolicy } from "../../src/standalone/owner-file-outbound-dnc-policy.ts";
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { outboundContactOutcomeRecordBinding } from "../../src/cliniko/outbound-contact-outcome-records.ts";
import type { OutboundContactOutcomeQuery, OutboundContactOutcomeHistoryQuery } from "../../src/cliniko/outbound-contact-outcome-records.ts";

export async function outboundContactSettlementFixture(options: NonNullable<Parameters<typeof outboundContactLifecycleFixture>[0]> & {
  Settlement?: typeof ClinikoOutboundContactSettlement; StopOwner?: typeof ClinikoOutboundStopOwner; Policy?: typeof OwnerFileOutboundDncPolicy;
}={}) {
  const {Settlement=ClinikoOutboundContactSettlement,StopOwner=ClinikoOutboundStopOwner,Policy=OwnerFileOutboundDncPolicy,...launch}=options;
  const f=await outboundStopOwnerFixture({...launch,LaunchFixture:outboundContactLifecycleFixture,StopOwner,Policy});
  try{
    // Native recovery is a later bounded phase. In-memory source controls use
    // their injected clock; SQL cohorts separately await real physical headroom.
    f.state.now="2026-11-02T00:01:00.000Z";
    const outcomes={...f.config.requests,outboundContactOutcomeRecallTypeId:"63",contactOutcomePolicyDigest:"d".repeat(64)};
    const state:{live:boolean;allowed:boolean;complete:boolean;terminal:boolean;contact:"noStopRequested"|"stopRequested";history:boolean;record:boolean;producer:boolean;
      beforeReport?:()=>void|Promise<void>;beforeTerminal?:()=>void|Promise<void>;beforeOutcome?:()=>void|Promise<void>;
      beforeGrant?:(q:OutboundContactSettlementQuery)=>void|Promise<void>;response?:(row:Record<string,unknown>)=>Response|Promise<Response>;reportPatch?:Record<string,unknown>;terminalPatch?:Record<string,unknown>}=
      {live:true,allowed:true,complete:true,terminal:true,contact:"noStopRequested",history:true,record:true,producer:true};
    const queries:OutboundContactSettlementQuery[]=[],nativeQueries:(OutboundContactOutcomeQuery|OutboundContactOutcomeHistoryQuery)[]=[],posts:Record<string,unknown>[]=[],burned=new Set<string>();
    const binding=outboundContactOutcomeRecordBinding(outcomes)!;
    const effects=options.effectFactory?.(f.request.scope,binding)??{matches:(s:typeof f.request.scope,b:string)=>JSON.stringify(s)===JSON.stringify(f.request.scope)&&b===binding,
      claimOnce:async(ref:string)=>{const claimed=!burned.has(ref);burned.add(ref);return {ok:true as const,value:{claimed}};}};
    const native:typeof fetch=async(input,init)=>{
      if(init?.method!=="POST")return f.nativeStop(input,init);const body=JSON.parse(String(init.body));
      if(body.recall_type_id!=="63")return f.nativeStop(input,init);
      assert.equal(String(input),"https://api.au5.cliniko.com/v1/recalls");assert.equal(init.redirect,"error");assert.equal(body.patient_id,f.attempt.patientId);
      posts.push(body);await state.beforeOutcome?.();
      const base="https://api.au5.cliniko.com/v1",row={id:"400",links:{self:`${base}/recalls/400`},patient:{links:{self:`${base}/patients/${body.patient_id}`}},recall_type:{links:{self:`${base}/recall_types/63`}},
        notes:body.notes,recall_at:body.recall_at,recalled:false,recalled_at:null,archived_at:null,created_at:f.state.now,updated_at:f.state.now};
      f.contactControls.rows.push(row);return state.response?state.response(row):Response.json(row,{status:201});
    };
    const reportedAt=f.state.now,attemptDigest=outboundLaunchAttemptDigest(f.attempt)!;
    const provider:OutboundContactSettlementProvider={binding:()=>f.providerBinding,
      inspectContact:async identity=>{await state.beforeReport?.();if(!state.complete)return {kind:"pending"};
        return {kind:"complete",complete:true,...identity,provider:f.providerBinding,attemptDigest,reportDigest:"b".repeat(64),reportedAt,contact:state.contact,
          ...(state.contact==="stopRequested"?{stop:{kind:"stop",...identity,provider:f.providerBinding,number:f.request.recipient.number,participant:"anyAtDialledNumber",stoppedAt:reportedAt,observedAt:reportedAt}}:{}),...state.reportPatch} as OutboundCompleteContactReport;},
      inspectTerminal:async identity=>{await state.beforeTerminal?.();return state.terminal?{kind:"terminal",complete:true,...identity,provider:f.providerBinding,endedAt:reportedAt,observedAt:f.state.now,...state.terminalPatch}:{kind:"active"};}};
    const {provider:_provider,native:_native,...stop}=f.stopPorts;
    const ports:Parameters<typeof ClinikoOutboundContactSettlement.create>[1]={stop,outcomes:{allows:async(q:OutboundContactOutcomeQuery)=>{nativeQueries.push(q);return state.record;},current:()=>state.live,producerAdmitted:async()=>state.producer},
      history:{allowsHistoryRead:async(q:OutboundContactOutcomeHistoryQuery)=>{nativeQueries.push(q);return state.history;},allowsRecordRead:async(q:OutboundContactOutcomeQuery)=>{nativeQueries.push(q);return state.record;},current:()=>state.live},
      outcomeEffects:effects,provider,capacity:f.capacity,native,authority:{allows:async(q:OutboundContactSettlementQuery)=>{queries.push(q);await state.beforeGrant?.(q);return state.allowed;},current:()=>state.live}};
    const config={stop:f.stopConfig,outcomes,account:f.account,guardRef:f.guardRef,capacityScope:f.request.scope,maximumNativeRequests:170,deadlineMs:15000};
    const make=()=>Settlement.create(config,ports),owner=value(make());
    return {...f,config,ports,owner,make,get claims(){return f.claims;},settlementState:state,settlementQueries:queries,nativeOutcomeQueries:nativeQueries,outcomePosts:posts,outcomeBurned:burned,
      nativeSettlement:native,settle:(signal=new AbortController().signal)=>owner.settleOnce(f.stopBinding,signal)};
  }catch(e){await f.close();throw e;}
}
