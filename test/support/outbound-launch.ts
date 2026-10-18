import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { outboundRequestValue } from "./outbound-recipient-request.ts";
import { outboundRecipientRequestDigest } from "../../src/cliniko/outbound-recipient-request.ts";
import type { OutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { ClinikoOutboundLaunchRecords, outboundLaunchRecordOwnerBinding } from "../../src/cliniko/outbound-launch-records.ts";
import type { OutboundLaunchRecordConfig, OutboundLaunchRecordAuthority, OutboundLaunchRecordQuery } from "../../src/cliniko/outbound-launch-records.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { value, outboundNow, outboundReviewDate } from "./outbound-records.ts";
export function outboundLaunchValue() {
  const request=outboundRequestValue(),attempt:OutboundLaunchAttempt={actionRef:randomUUID(),requestRecallRef:"cliniko:recall:30",requestActionRef:request.actionRef,
    requestDigest:outboundRecipientRequestDigest(request)!,campaignRef:request.campaignRef,approvalRef:request.approvalRef,effectRef:request.effectRef,
    scope:request.scope,businessId:request.businessId,credentialFingerprint:request.credentialFingerprint,patientId:request.patientId,
    provider:{ref:"synthetic-voice",bindingDigest:"e".repeat(64)},attemptedAt:outboundNow,dispatchNotAfter:"2026-11-01T10:01:00.000Z"};
  return {request,attempt};
}
export async function outboundLaunchFixture(options:{deadlineMs?:number;response?(row:Record<string,unknown>,method:string):Response|Promise<Response>;
  barrierFactory?(config:OutboundLaunchRecordConfig):OutboundEffectBarrier;attempt?:OutboundLaunchAttempt}={}) {
  const apiKey="synthetic-outbound-au5",seed=outboundLaunchValue(),attempt={...(options.attempt??seed.attempt),credentialFingerprint:clinikoCredentialFingerprint(apiKey)};
  let now=outboundNow,allowed=true,producer=true,live=true,claims=0,next=40;
  const config:OutboundLaunchRecordConfig={scope:attempt.scope,apiKey,contactEmail:"clinic@example.invalid",businessId:attempt.businessId,outboundAttemptRecallTypeId:"62",attemptPolicyDigest:"f".repeat(64),
    clock:()=>now,...(options.deadlineMs===undefined?{}:{deadlineMs:options.deadlineMs}),rateBudget:{claim:async()=>{claims++;return null;},observe429:async()=>({kind:"rateLimited"})}};
  const binding=outboundLaunchRecordOwnerBinding(config)!,burned=new Set<string>(),rows=new Map<string,Record<string,unknown>>(),queries:OutboundLaunchRecordQuery[]=[],calls:{method:string;path:string}[]=[];
  const barrier=options.barrierFactory?.(config)??{matches:(scope,owner)=>JSON.stringify(scope)===JSON.stringify(config.scope)&&owner===binding,
    claimOnce:async ref=>{const claimed=!burned.has(ref);burned.add(ref);return {ok:true as const,value:{claimed}};}} satisfies OutboundEffectBarrier;
  const authority:OutboundLaunchRecordAuthority={allows:async q=>{queries.push(q);return allowed;},current:()=>live,producerAdmitted:async()=>producer};
  const base="https://api.au5.cliniko.com/v1";
  const port:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),method=init?.method??"GET";assert.equal(url.origin,"https://api.au5.cliniko.com");assert.equal(init?.redirect,"error");
    assert.equal(new Headers(init?.headers).get("Authorization"),`Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);calls.push({method,path:url.pathname});let row:Record<string,unknown>;
    if(method==="POST") {
      assert.equal(url.pathname,"/v1/recalls");const body=JSON.parse(String(init?.body));assert.deepEqual(Object.keys(body).sort(),["notes","patient_id","recall_at","recall_type_id","recalled"]);
      assert.equal(body.recall_type_id,config.outboundAttemptRecallTypeId);const id=String(next++);row={id,links:{self:`${base}/recalls/${id}`},patient:{links:{self:`${base}/patients/${body.patient_id}`}},
        recall_type:{links:{self:`${base}/recall_types/${body.recall_type_id}`}},notes:body.notes,recall_at:body.recall_at,recalled:false,recalled_at:null,archived_at:null,created_at:now,updated_at:now,private_unknown:"discard-native-possible-launch-private"};rows.set(id,row);
    }else{assert.equal(method,"GET");row=rows.get(url.pathname.split("/").at(-1)!)!;}
    return options.response?options.response(row,method):Response.json(row,{status:method==="POST"?201:200});
  };
  const make=()=>ClinikoOutboundLaunchRecords.create(config,authority,barrier,port),records=value(make());
  return {request:seed.request,attempt,config,binding,barrier,burned,rows,queries,calls,authority,port,make,records,get claims(){return claims;},deny:()=>{allowed=false;},denyProducer:()=>{producer=false;},retire:()=>{live=false;},setNow:(at:string)=>{now=at;},
    retain:(signal=new AbortController().signal)=>records.retainPossibleAttemptOnce(attempt,outboundReviewDate,signal)};
}
