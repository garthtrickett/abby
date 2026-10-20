import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundContactSettlementFixture } from "../support/outbound-contact-settlement.ts";
import { outboundSettlementPeer } from "../support/outbound-contact-settlement-peer.ts";
import { value } from "../support/outbound-records.ts";
import { encodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { decodeOutboundContactOutcome } from "../../src/cliniko/outbound-contact-outcome.ts";
if(!process.env.DATABASE_URL)throw Error("DATABASE_URL required");
const db=connectPostgres(process.env.DATABASE_URL);after(()=>db.destroy());
const emitted=new URL("../../dist/runtime/src/",import.meta.url);
const {ClinikoOutboundContactSettlement}=await import(new URL("standalone/cliniko-outbound-contact-settlement.js",emitted).href) as typeof import("../../src/standalone/cliniko-outbound-contact-settlement.ts");
const {ClinikoOutboundLaunchOwner}=await import(new URL("standalone/cliniko-outbound-launch-owner.js",emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const {ClinikoOutboundStopOwner}=await import(new URL("standalone/cliniko-outbound-stop-owner.js",emitted).href) as typeof import("../../src/standalone/cliniko-outbound-stop-owner.ts");
const {OwnerFileOutboundCampaign}=await import(new URL("standalone/owner-file-outbound-campaign.js",emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const {OwnerFileOutboundContactAccount}=await import(new URL("standalone/owner-file-outbound-contact-account.js",emitted).href) as typeof import("../../src/standalone/owner-file-outbound-contact-account.ts");
const {OwnerFileOutboundDncPolicy}=await import(new URL("standalone/owner-file-outbound-dnc-policy.js",emitted).href) as typeof import("../../src/standalone/owner-file-outbound-dnc-policy.ts");
const {PostgresOutboundCapacity}=await import(new URL("storage/postgres-outbound-capacity.js",emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const {PostgresOutboundEffectBarrier}=await import(new URL("storage/postgres-outbound-effect-barrier.js",emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const {outboundContactGuardOwnerBinding}=await import(new URL("core/outbound-capacity.js",emitted).href) as typeof import("../../src/core/outbound-capacity.ts");
async function fixture(){
  const apiKey=`synthetic-settle-${randomUUID()}-au5`,scope={tenantId:`settle-${randomUUID()}`,clinicId:"clinic",locationId:"location"},guardRef=randomUUID();
  const budget=new PostgresClinikoRequestBudget(db,{apiKey,maxPerMinute:180}),capacity=new PostgresOutboundCapacity(db,scope,outboundContactGuardOwnerBinding(guardRef)!);
  const f=await outboundContactSettlementFixture({apiKey,scope,guardRef,capacity,budget,
    runtime:{ClinikoOutboundLaunchOwner,OwnerFileOutboundCampaign,OwnerFileOutboundContactAccount},Settlement:ClinikoOutboundContactSettlement,StopOwner:ClinikoOutboundStopOwner,Policy:OwnerFileOutboundDncPolicy,
    effectFactory:(s,b)=>new PostgresOutboundEffectBarrier(db,s,b),capacityFactory:(s,b)=>new PostgresOutboundCapacity(db,s,b)});
  // Explicit reviewed sparse-history profile, with derived full-cost refusal
  // before mutations. This is not a change to the shared account180 or deadlines.
  const config={...f.config,maximumNativeRequests:100},make=()=>ClinikoOutboundContactSettlement.create(config,f.ports),owner=value(make());
  return {...f,config,make,get claims(){return f.claims;},apiKey,scope,physicalBudget:budget,
    settle:(signal=new AbortController().signal)=>owner.settleOnce(f.stopBinding,signal)};
}
async function headroom(f:Awaited<ReturnType<typeof fixture>>){
  const until=Date.now()+75000;
  while(await f.physicalBudget.checkHeadroom(100)!==null){assert.ok(Date.now()<until,"wait only for actual physical native100 headroom");await new Promise(r=>setTimeout(r,500));}
}
async function held(f:Awaited<ReturnType<typeof fixture>>){
  return (await sql<{released_at:Date|null}>`select released_at from outbound_capacity_allocations where tenant_id=${f.scope.tenantId} and allocation_ref=${f.attempt.contactReferences!.allocationRef}::uuid`.execute(db)).rows[0]!.released_at===null;
}
async function privacy(f:Awaited<ReturnType<typeof fixture>>){
  const markers=[f.apiKey,f.request.recipient.number,"cliniko:recall:200","Abby outbound contact outcome v1","Abby possible outbound launch v4","Abby voice contact review v1"];
  assert.deepEqual(await scanPatientDataCanaries(db,markers.map((value,i)=>({label:`settle_${i}`,value}))),{ok:true,value:[]});
  const dump=execFileSync("pg_dump",[process.env.DATABASE_URL!,"--no-owner","--no-privileges"],{timeout:10000,maxBuffer:8000000}).toString();
  for(const secret of [...markers,String(f.requestRow.notes),String(f.row.notes),...f.outcomePosts.map(p=>String(p.notes)),...f.dncPosts.map(p=>String(p.notes))]){
    const copy=(v:string)=>v.replaceAll("\\","\\\\").replaceAll("\n","\\n").replaceAll("\r","\\r").replaceAll("\t","\\t");
    const json=JSON.stringify(secret).slice(1,-1);
    for(const encoded of [secret,copy(secret),json,copy(json)])assert.equal(dump.includes(encoded),false);
  }
}
for(const mode of ["noStop","stop","unknown","outcomeAckLoss","dncAckLoss"]as const)
  test(`emitted launch to contact settlement real SQL native180 and backup privacy: ${mode}`,{timeout:170000},async t=>{
    const f=await fixture();t.after(f.close);await headroom(f);const before=f.claims;
    if(mode==="stop"||mode==="dncAckLoss")f.settlementState.contact="stopRequested";
    if(mode==="unknown")f.settlementState.complete=false;
    if(mode==="outcomeAckLoss")f.settlementState.response=()=>Promise.reject(Error("synthetic lost native outcome ACK"));
    if(mode==="dncAckLoss")f.stopState.response=()=>Promise.reject(Error("synthetic lost native DNC ACK"));
    const first=value(await f.settle());
    if(mode==="unknown"){assert.equal(first.kind,"held");assert.equal(await held(f),true);assert.equal(f.outcomePosts.length,0);}
    else if(mode==="outcomeAckLoss"||mode==="dncAckLoss"){
      assert.equal(first.kind,"held");assert.equal(await held(f),true);delete f.settlementState.response;delete f.stopState.response;
      await headroom(f);const cold=value(await value(f.make()).settleOnce(f.stopBinding,new AbortController().signal));assert.equal(cold.kind,"nativeContactOutcomeRetained");
      if(cold.kind==="nativeContactOutcomeRetained")assert.equal(cold.contactHold,"released");
    }else{assert.equal(first.kind,"nativeContactOutcomeRetained");if(first.kind==="nativeContactOutcomeRetained")assert.equal(first.contactHold,"released");}
    assert.equal(await held(f),mode==="unknown");assert.equal(f.outcomePosts.length,mode==="unknown"?0:1);assert.equal(f.dncPosts.length,mode==="stop"||mode==="dncAckLoss"?1:0);
    assert.equal(f.calls.length,1);assert.ok(f.claims-before<=100,"reviewed complete sparse fixture cost remains bounded even through cold ACK recovery");
    if(f.outcomePosts.length){const o=value(decodeOutboundContactOutcome(f.outcomePosts[0]!.notes));assert.equal(o.actionRef,f.attempt.contactReferences!.outcomeActionRef);}
    await privacy(f);
  });
test("emitted contact release checks current authority after the real advisory-lock wait",{timeout:170000},async t=>{
  const f=await fixture();t.after(f.close);await headroom(f);
  let unlock!:()=>void,entered!:()=>void,blockerPid=0,blocker:Promise<void>|undefined;
  const gate=new Promise<void>(resolve=>{unlock=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  f.settlementState.beforeGrant=async q=>{if(q.operation!=="releaseContactHold"||blocker)return;
    blocker=db.transaction().execute(async trx=>{blockerPid=(await sql<{pid:number}>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid;
      await sql`select pg_advisory_xact_lock(172934501,hashtext(${f.scope.tenantId}))`.execute(trx);entered();await gate;});await ready;};
  const pending=f.settle();
  try{
    await ready;let waiting=false;const deadline=Date.now()+5000;
    while(!waiting&&Date.now()<deadline){waiting=(await sql<{waiting:boolean}>`select exists(select 1 from pg_locks where not granted and ${blockerPid}=any(pg_blocking_pids(pid))) as waiting`.execute(db)).rows[0]!.waiting;
      if(!waiting)await new Promise(r=>setTimeout(r,20));}
    assert.equal(waiting,true,"the actual emitted release is waiting on this transaction");f.settlementState.live=false;unlock();await blocker;
    assert.deepEqual(value(await pending),{kind:"nativeContactOutcomeRetained",recallRef:"cliniko:recall:400",contactHold:"releaseUnconfirmed"});
    assert.equal(await held(f),true);assert.equal(f.outcomePosts.length,1);await privacy(f);
  }finally{unlock();await blocker;await pending;}
});
for(const point of ["dncAck","outcomeAck","release"]as const)
  test(`emitted owner SIGKILL at ${point} retains contact hold; a fresh owner recovers exact native facts once`,{timeout:170000},async t=>{
    const f=await fixture();t.after(f.close);if(point==="dncAck")f.settlementState.contact="stopRequested";await headroom(f);
    const cwd=await mkdtemp(join(tmpdir(),"abby-settle-empty-"));t.after(()=>rm(cwd,{recursive:true,force:true}));let reached!:()=>void;
    const waiting=new Promise<void>(resolve=>{reached=resolve;}),peer=await outboundSettlementPeer(f,cwd,reached,point);t.after(peer.kill);
    await Promise.race([waiting,peer.errors,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error("Synthetic settlement boundary not reached")),20000);t.after(()=>clearTimeout(timer));})]);
    await peer.kill();assert.deepEqual(peer.output,[]);assert.deepEqual(await readdir(cwd),[]);assert.equal(await held(f),true);
    await headroom(f);const recovered=value(await value(f.make()).settleOnce(f.stopBinding,new AbortController().signal));
    assert.equal(recovered.kind,"nativeContactOutcomeRetained");if(recovered.kind==="nativeContactOutcomeRetained")assert.equal(recovered.contactHold,"released");
    assert.equal(f.outcomePosts.length,1);assert.equal(f.dncPosts.length,point==="dncAck"?1:0);assert.equal(await held(f),false);assert.equal(f.calls.length,1);await privacy(f);
  });

test("emitted native reference edits cannot borrow a completed call to clear another opaque contact hold",{timeout:170000},async t=>{
  const f=await fixture();t.after(f.close);await headroom(f);
  const pair={effectRef:randomUUID(),capacityAllocationRef:randomUUID()};
  const originalOther={...f.attempt,...pair,actionRef:randomUUID(),contactReferences:{...f.attempt.contactReferences!,allocationRef:randomUUID(),outcomeActionRef:randomUUID()}};
  f.row.notes=value(encodeOutboundLaunchAttempt({...f.attempt,...pair}));f.row.updated_at=f.state.now;
  f.settlementState.reportPatch={...pair,attemptDigest:outboundLaunchAttemptDigest(originalOther)};f.settlementState.terminalPatch={...pair};
  assert.equal((await f.settle()).ok,false);assert.equal(await held(f),true);
  assert.equal(f.outcomePosts.length,0);assert.equal(f.dncPosts.length,0);assert.equal(f.calls.length,1);await privacy(f);
});
