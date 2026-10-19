import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { outboundLaunchValue } from "./outbound-launch.ts";
import { value } from "./outbound-records.ts";
import type { OutboundLaunchRecord } from "../../src/cliniko/outbound-launch-records.ts";
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import type { OutboundContactOutcome } from "../../src/cliniko/outbound-contact-outcome.ts";
import { ClinikoOutboundContactOutcomeRecords, ClinikoOutboundContactOutcomeHistory, outboundContactOutcomeRecordBinding } from "../../src/cliniko/outbound-contact-outcome-records.ts";
import type { OutboundContactOutcomeQuery, OutboundContactOutcomeHistoryQuery } from "../../src/cliniko/outbound-contact-outcome-records.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";

export function outboundContactOutcomeValue(fp?: string, stopped=false) {
  const { attempt: a }=outboundLaunchValue(),attempt={...a,...(fp?{credentialFingerprint:fp}:{}),capacityAllocationRef:randomUUID(),
    dncReferences:{actionRef:randomUUID(),approvalRef:randomUUID()},contactReferences:{guardRef:randomUUID(),allocationRef:randomUUID(),outcomeActionRef:randomUUID()}};
  const possible:OutboundLaunchRecord={kind:"possibleLaunchContext",recallRef:"cliniko:recall:200",attempt,recallAt:"2026-11-02",createdAt:attempt.attemptedAt,updatedAt:attempt.attemptedAt,recalled:false,recalledAt:null,archivedAt:null};
  const outcome:OutboundContactOutcome={actionRef:attempt.contactReferences.outcomeActionRef,scope:attempt.scope,businessId:attempt.businessId,credentialFingerprint:attempt.credentialFingerprint,patientId:attempt.patientId,
    attempt:{recallRef:possible.recallRef,actionRef:attempt.actionRef,digest:outboundLaunchAttemptDigest(attempt)!},
    result:stopped?{kind:"stopRetained",reportDigest:"b".repeat(64),decision:{recallRef:"cliniko:recall:300",actionRef:attempt.dncReferences.actionRef,digest:"c".repeat(64)}}:{kind:"completeNoStop",reportDigest:"b".repeat(64)},
    terminal:{endedAt:"2026-11-01T10:02:00.000Z",observedAt:"2026-11-01T10:03:00.000Z"},reportedAt:"2026-11-01T10:02:30.000Z",recordedAt:"2026-11-01T10:04:00.000Z"};
  return {possible,outcome};
}
export function outboundContactOutcomeFixture(options:{deadlineMs?:number;stopped?:boolean}={}) {
  const apiKey="synthetic-contact-outcome-au5",{possible,outcome}=outboundContactOutcomeValue(clinikoCredentialFingerprint(apiKey),options.stopped),base="https://api.au5.cliniko.com/v1";
  const state:{now:string;live:boolean;allowed:boolean;producer:boolean;claims:number;next:number;response?:(row:Record<string,unknown>,method:string)=>Response|Promise<Response>;
    page?:(rows:Record<string,unknown>[],page:number)=>Response|Promise<Response>;grant?:(q:OutboundContactOutcomeQuery|OutboundContactOutcomeHistoryQuery)=>boolean|Promise<boolean>}={now:outcome.recordedAt,live:true,allowed:true,producer:true,claims:0,next:400};
  const queries:(OutboundContactOutcomeQuery|OutboundContactOutcomeHistoryQuery)[]=[],rows=new Map<string,Record<string,unknown>>(),calls:{method:string;path:string}[]=[],burned=new Set<string>();
  const config={scope:outcome.scope,businessId:outcome.businessId,apiKey,contactEmail:"clinic@example.invalid",outboundContactOutcomeRecallTypeId:"63",contactOutcomePolicyDigest:"d".repeat(64),
    rateBudget:{claim:async()=>{state.claims++;return null;},observe429:async()=>({kind:"rateLimited" as const})},clock:()=>state.now,...(options.deadlineMs===undefined?{}:{deadlineMs:options.deadlineMs})};
  const owner=outboundContactOutcomeRecordBinding(config)!;
  const authority={allows:async(q:OutboundContactOutcomeQuery)=>{queries.push(q);return state.grant?state.grant(q):state.allowed;},current:()=>state.live,producerAdmitted:async()=>state.producer};
  const historyAuthority={allowsHistoryRead:async(q:OutboundContactOutcomeHistoryQuery)=>{queries.push(q);return state.grant?state.grant(q):state.allowed;},allowsRecordRead:authority.allows,current:authority.current};
  const effects={matches:(scope:typeof outcome.scope,binding:string)=>JSON.stringify(scope)===JSON.stringify(config.scope)&&binding===owner,
    claimOnce:async(ref:string)=>{const claimed=!burned.has(ref);burned.add(ref);return {ok:true as const,value:{claimed}};}};
  const native:typeof fetch=async(input,init)=>{const url=new URL(String(input)),method=init?.method??"GET";assert.equal(url.origin,base.slice(0,-3));assert.equal(init?.redirect,"error");
    assert.equal(new Headers(init?.headers).get("Authorization"),`Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);calls.push({method,path:url.pathname});
    if(method==="GET"&&url.pathname==="/v1/recalls"){
      assert.deepEqual(url.searchParams.getAll("q[]"),[`patient_id:=${outcome.patientId}`,"archived_at:*"]);const page=Number(url.searchParams.get("page")),all=[...rows.values()].sort((a,b)=>Number(a.id)-Number(b.id));
      const selected=all.slice((page-1)*100,page*100);return state.page?state.page(selected,page):Response.json({recalls:selected,total_entries:all.length});
    }
    let row:Record<string,unknown>;
    if(method==="POST"){
      assert.equal(url.pathname,"/v1/recalls");const body=JSON.parse(String(init?.body));assert.deepEqual(Object.keys(body).sort(),["notes","patient_id","recall_at","recall_type_id","recalled"]);
      assert.equal(body.recall_type_id,"63");const id=String(state.next++);row={id,links:{self:`${base}/recalls/${id}`},patient:{links:{self:`${base}/patients/${body.patient_id}`}},recall_type:{links:{self:`${base}/recall_types/63`}},
        notes:body.notes,recall_at:body.recall_at,recalled:false,recalled_at:null,archived_at:null,created_at:state.now,updated_at:state.now};rows.set(id,row);
    }else{assert.equal(method,"GET");assert.deepEqual(url.searchParams.getAll("q[]"),["archived_at:*"]);row=rows.get(url.pathname.split("/").at(-1)!)!;assert.ok(row);}
    return state.response?state.response(row,method):Response.json(row,{status:method==="POST"?201:200});
  };
  const make=()=>ClinikoOutboundContactOutcomeRecords.create(config,authority,effects,native),records=value(make());
  const history=()=>value(ClinikoOutboundContactOutcomeHistory.create(config,historyAuthority,native));
  return {possible,outcome,config,authority,historyAuthority,effects,native,rows,calls,burned,state,queries,make,records,history,
    retain:(signal=new AbortController().signal)=>records.retainOutcomeOnce(outcome,possible.recallAt,signal),
    find:(signal=new AbortController().signal)=>history().findForAttempt(possible,signal)};
}
