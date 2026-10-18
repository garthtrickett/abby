import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoOutboundLaunchRecords } from "../../src/cliniko/outbound-launch-records.ts";
import { outboundLaunchFixture } from "../support/outbound-launch.ts";
import { value,outboundNow } from "../support/outbound-records.ts";
test("exact possible-attempt retention burns only its record action and never launches or claims future approval/effect",async()=>{
  const f=await outboundLaunchFixture(),retained=value(await f.retain());assert.equal(retained.kind,"accepted");assert.equal(f.calls.length,1);assert.deepEqual([...f.burned],[f.attempt.actionRef]);
  assert.equal(f.burned.has(f.attempt.effectRef),false);assert.equal(f.burned.has(f.attempt.approvalRef),false);assert.equal(f.queries[0]!.operation,"retainPossibleLaunch");
  assert.deepEqual(await f.retain(),{ok:false,error:{kind:"alreadyClaimed"}});assert.equal(f.calls.length,1);
});
test("genuine readonly possible-attempt reader preserves closed and archived evidence without producer permission",async()=>{
  const f=await outboundLaunchFixture(),retained=value(await f.retain());if(retained.kind!=="accepted")assert.fail();const row=f.rows.get("40")!;
  row.recalled=true;row.recalled_at=outboundNow;row.archived_at=outboundNow;f.denyProducer();f.setNow("2026-11-02T10:00:00.000Z");
  const reader=value(ClinikoOutboundLaunchRecords.createReadOnly(f.config,f.authority,f.port)),read=value(await reader.readPossibleAttempt({recallRef:retained.recallRef,actionRef:f.attempt.actionRef,patientId:f.attempt.patientId},new AbortController().signal));
  assert.equal(read.kind,"possibleLaunchContext");assert.equal(read.recalled,true);assert.equal(read.archivedAt,outboundNow);assert.deepEqual(read.attempt,f.attempt);assert.equal(Object.hasOwn(read,"private_unknown"),false);
  const cast=reader as ClinikoOutboundLaunchRecords;assert.deepEqual(await cast.retainPossibleAttemptOnce(f.attempt,"2026-11-02",new AbortController().signal),{ok:false,error:{kind:"forbidden"}});
});
for(const denied of ["record","producer"] as const)test(`independent possible-attempt ${denied} denial prevents claim and native POST`,async()=>{
  const f=await outboundLaunchFixture();if(denied==="record")f.deny();else f.denyProducer();assert.deepEqual(await f.retain(),{ok:false,error:{kind:"forbidden"}});assert.equal(f.calls.length,0);assert.equal(f.burned.size,0);
});
test("lost possible-attempt acknowledgement remains uncertain and consumed across cold owners",async()=>{
  const f=await outboundLaunchFixture({response:()=>{throw new Error("lost private provider response");}});assert.deepEqual(await f.retain(),{ok:true,value:{kind:"uncertain"}});
  assert.deepEqual(await value(f.make()).retainPossibleAttemptOnce(f.attempt,"2026-11-02",new AbortController().signal),{ok:false,error:{kind:"alreadyClaimed"}});assert.equal(f.calls.length,1);
});
test("request-shaped configuration cannot activate possible-launch record storage",async()=>{
  const f=await outboundLaunchFixture();const {outboundAttemptRecallTypeId:_id,attemptPolicyDigest:_digest,...base}=f.config;
  assert.equal(ClinikoOutboundLaunchRecords.create({...base,outboundRecallTypeId:"61",recordPolicyDigest:"a".repeat(64)} as unknown as typeof f.config,f.authority,f.barrier,f.port).ok,false);
});
