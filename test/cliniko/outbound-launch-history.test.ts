import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { outboundLaunchHistoryFixture } from "../support/outbound-launch-history.ts";
import { encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { outboundNow, value } from "../support/outbound-records.ts";
const row = (f: Awaited<ReturnType<typeof outboundLaunchHistoryFixture>>) => f.controls.rows[0]!;
function patientRows(f: Awaited<ReturnType<typeof outboundLaunchHistoryFixture>>,count:number) {
  const original=row(f);
  f.controls.rows=Array.from({length:count},(_,i)=>({...structuredClone(original),id:String(40+i),links:{self:`https://api.au5.cliniko.com/v1/recalls/${40+i}`},
    ...(i?{recall_type:{links:{self:"https://api.au5.cliniko.com/v1/recall_types/99"}},notes:null}:{})}));
}
test("cold complete history preserves archived closed attempts after dispatch expiry and local record-claim loss",async()=>{
  const f=await outboundLaunchHistoryFixture();for(const r of [row(f),f.f.rows.get("40")!]){r.recalled=true;r.recalled_at=outboundNow;r.archived_at=outboundNow;}
  f.f.burned.clear();f.f.denyProducer();f.f.setNow("2026-11-03T10:00:00.000Z");const before=f.f.claims;
  const result=value(await f.scan());assert.equal(result.kind,"possibleLaunchHistory");assert.equal(result.records.length,1);assert.equal(result.scanned,1);
  assert.deepEqual(result.records[0]!.attempt,f.f.attempt);assert.equal(result.records[0]!.archivedAt,outboundNow);assert.equal(result.records[0]!.recalled,true);
  assert.equal(f.f.claims-before,2);assert.equal(f.f.burned.size,0);assert.equal(f.calls.length,2);
  assert.ok(f.accountQueries.every(q=>q.includeArchived&&q.includeClosed&&q.patientId===f.request.patientId));
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.records)&&Object.isFrozen(result.records[0]!.attempt));
});
for(const denied of ["account","record","decoded"] as const)test(`history independently refuses ${denied} grant denial without private result`,async()=>{
  const f=await outboundLaunchHistoryFixture();if(denied==="account")f.denyAccount();else if(denied==="record")f.denyRecord();
  else Object.assign(f.authority,{allowsRecordRead:async(q:import("../../src/cliniko/outbound-launch-records.ts").OutboundLaunchRecordQuery)=>q.attemptDigest===undefined});
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"forbidden"}});assert.equal(f.calls.length,denied==="account"?0:denied==="record"?1:2);
});
for(const count of [0,100,101,500])test(`history scans ${count} exact patient rows without inventing partial absence`,async()=>{
  const f=await outboundLaunchHistoryFixture();patientRows(f,count);const result=value(await f.scan());assert.equal(result.scanned,count);assert.equal(result.records.length,count?1:0);
  assert.equal(f.calls.length,Math.max(1,Math.ceil(count/100))+(count?1:0));
});
for(const change of ["overBound","negative","fraction","missingRows","duplicateId","foreignSelf","foreignPatient","missingArchived","unknownRecalled","missingRecalledAt","futureUpdated","badNotes","futureArchive"] as const)
 test(`incomplete or malformed ${change} history refuses before exact record reads`,async()=>{
  const f=await outboundLaunchHistoryFixture(),r=row(f);
  if(change==="overBound")f.controls.total=501;if(change==="negative")f.controls.total=-1;if(change==="fraction")f.controls.total=1.5;
  if(change==="missingRows")f.controls.total=2;if(change==="duplicateId")f.controls.rows.push(structuredClone(r));
  if(change==="foreignSelf")r.links={self:"https://other.invalid/recalls/40"};
  if(change==="foreignPatient")r.patient={links:{self:"https://api.au5.cliniko.com/v1/patients/999"}};
  if(change==="missingArchived")delete r.archived_at;if(change==="unknownRecalled")r.recalled=null;if(change==="missingRecalledAt")delete r.recalled_at;
  if(change==="futureUpdated")r.updated_at="2026-11-01T10:01:00.000Z";if(change==="badNotes")r.notes="unknown private attempt";
  if(change==="futureArchive")r.archived_at="2026-11-01T10:00:01.000Z";
  assert.equal((await f.scan()).ok,false);assert.equal(f.calls.length,1);
 });
test("unstable page totals cannot produce an empty or partial history",async()=>{
  const f=await outboundLaunchHistoryFixture();patientRows(f,101);f.controls.page=(rows,page)=>Response.json({recalls:rows,total_entries:page===1?101:102});
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"malformed"}});assert.equal(f.calls.length,2);
});
for(const change of ["note","closed","archived","updated","reviewDate"] as const)test(`history refuses ${change} mutation between collection and exact read`,async()=>{
  const f=await outboundLaunchHistoryFixture();f.controls.get=original=>{const r=structuredClone(original);
    if(change==="note")r.notes=value(encodeOutboundLaunchAttempt({...f.f.attempt,provider:{...f.f.attempt.provider,ref:"other-provider"}}));
    if(change==="closed"){r.recalled=true;r.recalled_at=outboundNow;}if(change==="archived")r.archived_at=outboundNow;
    if(change==="updated")r.updated_at="2026-11-01T10:00:01.000Z";if(change==="reviewDate")r.recall_at="2026-11-03";return Response.json(r);};
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"mismatched"}});
});
for(const field of ["requestRecallRef","requestActionRef","requestDigest","campaignRef","approvalRef","effectRef"] as const)
 test(`related conflicting original ${field} is refused rather than discarded as unrelated`,async()=>{
  const f=await outboundLaunchHistoryFixture(),a={...f.f.attempt,[field]:field==="requestRecallRef"?"cliniko:recall:31":field==="requestDigest"?"a".repeat(64):randomUUID()};
  const notes=value(encodeOutboundLaunchAttempt(a));row(f).notes=notes;f.f.rows.get("40")!.notes=notes;
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"mismatched"}});
 });
test("fully unrelated same-patient attempt is authorized and reread but not merged with the original request",async()=>{
  const f=await outboundLaunchHistoryFixture(),a={...f.f.attempt,requestRecallRef:"cliniko:recall:99",requestActionRef:randomUUID(),approvalRef:randomUUID(),effectRef:randomUUID()};
  const notes=value(encodeOutboundLaunchAttempt(a));row(f).notes=notes;f.f.rows.get("40")!.notes=notes;
  assert.equal(value(await f.scan()).records.length,0);assert.equal(f.calls.length,2);
});
test("multiple independent possible records for one effect remain evidence, never reset or merge the effect",async()=>{
  const f=await outboundLaunchHistoryFixture(),a={...f.f.attempt,actionRef:randomUUID()},r={...structuredClone(row(f)),id:"41",links:{self:"https://api.au5.cliniko.com/v1/recalls/41"},notes:value(encodeOutboundLaunchAttempt(a))};
  f.controls.rows.push(r);f.f.rows.set("41",r);assert.equal(value(await f.scan()).records.length,2);assert.equal(f.f.burned.size,1);
  r.notes=value(encodeOutboundLaunchAttempt(f.f.attempt));assert.deepEqual(await f.scan(),{ok:false,error:{kind:"mismatched"}});
});
for(const stage of ["grant","headers","body"] as const)test(`history deadline includes held ${stage}`,{timeout:3000},async()=>{
  const f=await outboundLaunchHistoryFixture({deadlineMs:100});let cancelled=0;
  if(stage==="grant")Object.assign(f.authority,{allowsHistoryRead:()=>new Promise(()=>{})});
  if(stage==="headers")f.controls.page=()=>new Promise(()=>{});
  if(stage==="body")f.controls.page=()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{status:200});
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"unavailable"}});if(stage==="body")assert.equal(cancelled,1);
});
test("withdrawal after native lookup prevents returning already loaded history",async()=>{
  const f=await outboundLaunchHistoryFixture();f.controls.get=r=>{f.retire();return Response.json(r);};assert.deepEqual(await f.scan(),{ok:false,error:{kind:"forbidden"}});
});

for(const count of [50,51])test(`history ${count===50?"retains":"refuses"} ${count} selected native attempts without truncating evidence`,async()=>{
 const f=await outboundLaunchHistoryFixture(),original=row(f);f.controls.rows=[];
 for(let i=0;i<count;i++){
  const id=String(40+i),r={...structuredClone(original),id,links:{self:`https://api.au5.cliniko.com/v1/recalls/${id}`},notes:value(encodeOutboundLaunchAttempt({...f.f.attempt,actionRef:randomUUID()}))};
  f.controls.rows.push(r);f.f.rows.set(id,r);
 }
 const found=await f.scan();if(count===50){assert.equal(value(found).records.length,50);assert.equal(f.calls.length,51);}
 else{assert.deepEqual(found,{ok:false,error:{kind:"malformed"}});assert.equal(f.calls.length,1);}
});
test("shared quota refusal prevents history GET without claiming any launch or record ID",async()=>{
 const f=await outboundLaunchHistoryFixture();f.f.burned.clear();Object.assign(f.f.config.rateBudget,{claim:async()=>({kind:"rateLimited"})});
 assert.deepEqual(await f.scan(),{ok:false,error:{kind:"rateLimited"}});assert.equal(f.calls.length,0);assert.equal(f.f.burned.size,0);
});
test("history observes native429 through the unchanged shared account budget",async()=>{
 const f=await outboundLaunchHistoryFixture();let observed=0;Object.assign(f.f.config.rateBudget,{observe429:async()=>{observed++;return {kind:"rateLimited"};}});
 f.controls.page=()=>new Response(null,{status:429});assert.deepEqual(await f.scan(),{ok:false,error:{kind:"rateLimited"}});assert.equal(observed,1);assert.equal(f.calls.length,1);
});
for(const at of ["not-a-time","2026-11-01T10:00:00Z","2026-11-01T09:59:59.000Z"])test(`history refuses noncanonical or backwards clock ${at}`,async()=>{
 const f=await outboundLaunchHistoryFixture();let called=false;f.controls.page=rows=>{called=true;f.f.setNow(at);return Response.json({recalls:rows,total_entries:rows.length});};
 assert.deepEqual(await f.scan(),{ok:false,error:{kind:"unavailable"}});assert.equal(called,true);assert.equal(f.calls.length,1);
});
test("history snapshots original source and permission methods before a held grant",async()=>{
 const f=await outboundLaunchHistoryFixture();let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{entered=r;});
 Object.assign(f.authority,{allowsHistoryRead:async()=>{entered();await held;return true;}});
 const history=value(f.make()),pending=history.readForRequest({recallRef:f.f.attempt.requestRecallRef,request:f.request},new AbortController().signal);await began;
 Object.assign(f.request,{recipient:{kind:"voice",number:"+61411111111"}});Object.assign(f.authority,{allowsHistoryRead:async()=>false});release();
 const found=value(await pending);assert.equal(found.records.length,1);assert.deepEqual(found.records[0]!.attempt,f.f.attempt);
});
test("external abort terminates held history grant and its late resolution never dispatches a GET",async()=>{
 const f=await outboundLaunchHistoryFixture();let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{entered=r;});
 Object.assign(f.authority,{allowsHistoryRead:async()=>{entered();await held;return true;}});const controller=new AbortController(),pending=f.scan(controller.signal);await began;controller.abort();
 assert.deepEqual(await pending,{ok:false,error:{kind:"unavailable"}});release();await new Promise<void>(r=>setImmediate(r));assert.equal(f.calls.length,0);
});
