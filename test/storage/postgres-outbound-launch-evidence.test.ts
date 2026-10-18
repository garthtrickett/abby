import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { outboundRecipientRequestDigest } from "../../src/cliniko/outbound-recipient-request.ts";
import { outboundLaunchFixture } from "../support/outbound-launch.ts";
import { outboundLaunchHistoryFixture } from "../support/outbound-launch-history.ts";
import { outboundLaunchPeer } from "../support/outbound-launch-peer.ts";
import { outboundRequestValue } from "../support/outbound-recipient-request.ts";
import { value, outboundNow } from "../support/outbound-records.ts";
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL required");
const db=connectPostgres(process.env.DATABASE_URL);after(()=>db.destroy());
function requestValue(){const r=outboundRequestValue();return {...r,scope:{...r.scope,tenantId:`outbound-possible-${randomUUID()}`}};}
type Fixture=Awaited<ReturnType<typeof outboundLaunchFixture>>;
async function claims(f:Fixture,ref:string){return (await sql`select effect_ref from outbound_effect_barriers where tenant_id=${f.request.scope.tenantId} and effect_ref=${ref}::uuid`.execute(db)).rows;}
async function setup(){
 const f=await outboundLaunchFixture({request:requestValue()}),native=f.port;
 f.port=async(input,init)=>{
  if(init?.method==="POST"){
   assert.equal((await claims(f,f.attempt.actionRef)).length,1,"real permanent record exclusion precedes native possible-attempt POST");
   for(const ref of [f.attempt.requestActionRef,f.attempt.approvalRef,f.attempt.effectRef])assert.equal((await claims(f,ref)).length,0,"possible record cannot claim original or future launch IDs");
  }
  return native(input,init);
 };return f;
}
async function privacy(f:Fixture){
 const canaries=[f.request.recipient.number,outboundRecipientRequestDigest(f.request)!,outboundLaunchAttemptDigest(f.attempt)!,"Abby possible outbound launch v1","discard-native-possible-launch-private"];
 assert.deepEqual(await scanPatientDataCanaries(db,canaries.map((value,i)=>({label:`possible_launch_${i}`,value}))),{ok:true,value:[]});
 const dump=execFileSync("pg_dump",[process.env.DATABASE_URL!,"--no-owner","--no-privileges"],{timeout:10000,maxBuffer:8_000_000}).toString();
 for(const canary of canaries)assert.equal(dump.includes(canary),false);
}
test("compiled possible-attempt recorder consumes SQL once and cold read preserves closed evidence without producer permission",{timeout:35000},async t=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),"abby-possible-launch-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const first=await outboundLaunchPeer(f,dir);t.after(first.kill);const retained=value(await first.nextResult());await first.kill();assert.equal(retained.kind,"accepted");if(retained.kind!=="accepted")assert.fail();
 const cold=await outboundLaunchPeer(f,dir);t.after(cold.kill);assert.deepEqual(await cold.nextResult(),{ok:false,error:{kind:"alreadyClaimed"}});await cold.kill();
 const row=f.rows.get("40")!;row.recalled=true;row.recalled_at=outboundNow;row.archived_at=outboundNow;f.setNow("2026-11-03T10:00:00.000Z");
 const reader=await outboundLaunchPeer(f,dir,{mode:"readPossible",withoutDatabase:true,recallRef:retained.recallRef,denied:"producer"});t.after(reader.kill);
 const found=value(await reader.nextResult());await reader.kill();assert.equal(found.kind,"possibleLaunchContext");if(found.kind!=="possibleLaunchContext")assert.fail();
 assert.deepEqual(found.attempt,f.attempt);assert.equal(found.recalled,true);assert.equal(found.archivedAt,outboundNow);
 assert.equal(f.calls.filter(c=>c.method==="POST").length,1);assert.deepEqual([...first.output,...cold.output,...reader.output],[]);assert.deepEqual(await readdir(dir),[]);await privacy(f);
});
test("concurrent compiled possible-attempt owners share one actual SQL exclusion and one native POST",{timeout:35000},async t=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),"abby-possible-race-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const [a,b]=await Promise.all([outboundLaunchPeer(f,dir),outboundLaunchPeer(f,dir)]);t.after(a.kill);t.after(b.kill);
 const results=await Promise.all([a.nextResult(),b.nextResult()]);await a.kill();await b.kill();assert.equal(results.filter(r=>r.ok&&r.value.kind==="accepted").length,1);
 assert.equal(f.calls.filter(c=>c.method==="POST").length,1);assert.deepEqual([...a.output,...b.output],[]);assert.deepEqual(await readdir(dir),[]);await privacy(f);
});
test("SIGKILL after possible-attempt POST keeps SQL consumption and native evidence without claiming a launch",{timeout:35000},async t=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),"abby-possible-loss-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 let submitted!:()=>void;const pending=new Promise<void>(resolve=>{submitted=resolve;});
 const first=await outboundLaunchPeer(f,dir,{holdPostReply:true,onSubmitted:submitted});t.after(first.kill);
 let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Synthetic possible POST deadline")),10000);})]);}finally{if(timer)clearTimeout(timer);}
 await first.kill();assert.equal(f.rows.size,1);const cold=await outboundLaunchPeer(f,dir);t.after(cold.kill);assert.deepEqual(await cold.nextResult(),{ok:false,error:{kind:"alreadyClaimed"}});await cold.kill();
 assert.equal(f.calls.length,1);for(const ref of [f.attempt.effectRef,f.attempt.approvalRef])assert.equal((await claims(f,ref)).length,0);await privacy(f);
});
for(const denied of ["record","producer"] as const)test(`compiled independent possible-attempt ${denied} denial prevents SQL and provider I/O`,{timeout:35000},async t=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),"abby-possible-deny-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const peer=await outboundLaunchPeer(f,dir,{denied});t.after(peer.kill);assert.deepEqual(await peer.nextResult(),{ok:false,error:{kind:"forbidden"}});await peer.kill();
 assert.equal((await claims(f,f.attempt.actionRef)).length,0);assert.equal(f.calls.length,0);assert.deepEqual(peer.output,[]);assert.deepEqual(await readdir(dir),[]);await privacy(f);
});
for(const mode of ["closedHistory","accountDenied","recordDenied","changed"] as const)test(`compiled ${mode} inspection after local claim loss stays outside SQL, backups and worker output`,{timeout:35000},async t=>{
 const f=await outboundLaunchHistoryFixture({request:requestValue()});f.f.burned.clear();f.f.denyProducer();f.f.setNow("2026-11-03T10:00:00.000Z");
 for(const row of [f.controls.rows[0]!,f.f.rows.get("40")!]){row.recalled=true;row.recalled_at=outboundNow;row.archived_at=outboundNow;}
 if(mode==="accountDenied")f.denyAccount();if(mode==="recordDenied")f.denyRecord();if(mode==="changed")f.controls.get=r=>Response.json({...r,archived_at:null});f.f.port=f.port;
 const dir=await mkdtemp(join(tmpdir(),"abby-possible-history-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const peer=await outboundLaunchPeer(f.f,dir,{mode:"history",withoutDatabase:true,historyAuthority:f.authority});t.after(peer.kill);const result=await peer.nextResult();await peer.kill();
 if(mode==="closedHistory"){const found=value(result);assert.equal(found.kind,"possibleLaunchHistory");if(found.kind!=="possibleLaunchHistory")assert.fail();assert.equal(found.records.length,1);assert.deepEqual(found.records[0]!.attempt,f.f.attempt);assert.equal(found.records[0]!.archivedAt,outboundNow);}
 else assert.deepEqual(result,{ok:false,error:{kind:mode==="changed"?"mismatched":"forbidden"}});
 assert.equal((await claims(f.f,f.f.attempt.actionRef)).length,0);assert.deepEqual(peer.output,[]);assert.deepEqual(await readdir(dir),[]);await privacy(f.f);
});
test("compiled cold history survives removal of an actual SQL record claim after native retention",{timeout:35000},async t=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),"abby-possible-sql-loss-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const first=await outboundLaunchPeer(f,dir);t.after(first.kill);const retained=value(await first.nextResult());await first.kill();assert.equal(retained.kind,"accepted");
 assert.equal((await claims(f,f.attempt.actionRef)).length,1);
 // Deliberate loss in this disposable test database represents an older local
 // restore. No production journal reset or replay interface is introduced.
 await sql`delete from outbound_effect_barriers where tenant_id=${f.request.scope.tenantId} and effect_ref=${f.attempt.actionRef}::uuid`.execute(db);
 assert.equal((await claims(f,f.attempt.actionRef)).length,0);
 const native=f.port,row=f.rows.get("40")!;row.recalled=true;row.recalled_at=outboundNow;row.archived_at=outboundNow;f.setNow("2026-11-03T10:00:00.000Z");f.denyProducer();
 f.port=async(input,init)=>{
  const url=new URL(String(input));if(url.pathname!=="/v1/recalls")return native(input,init);
  assert.equal(init?.method,"GET");assert.deepEqual(url.searchParams.getAll("q[]"),[`patient_id:=${f.request.patientId}`,"archived_at:*"]);
  return Response.json({recalls:[row],total_entries:1});
 };
 const authority={allowsHistoryRead:async()=>true,allowsRecordRead:f.authority.allows,current:f.authority.current};
 const reader=await outboundLaunchPeer(f,dir,{mode:"history",withoutDatabase:true,historyAuthority:authority});t.after(reader.kill);
 const result=value(await reader.nextResult());await reader.kill();assert.equal(result.kind,"possibleLaunchHistory");if(result.kind!=="possibleLaunchHistory")assert.fail();
 assert.equal(result.records.length,1);assert.deepEqual(result.records[0]!.attempt,f.attempt);assert.equal(result.records[0]!.archivedAt,outboundNow);
 assert.equal((await claims(f,f.attempt.actionRef)).length,0);assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
 for(const ref of [f.attempt.effectRef,f.attempt.approvalRef])assert.equal((await claims(f,ref)).length,0);
 assert.deepEqual([...first.output,...reader.output],[]);assert.deepEqual(await readdir(dir),[]);await privacy(f);
});
