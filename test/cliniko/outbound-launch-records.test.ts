import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoOutboundLaunchRecords } from "../../src/cliniko/outbound-launch-records.ts";
import { outboundLaunchFixture } from "../support/outbound-launch.ts";
import { value,outboundNow } from "../support/outbound-records.ts";
import { randomUUID } from "node:crypto";
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
test("exact cold possible-attempt GET requests archive inclusion under its independent current record grant",async()=>{
 const f=await outboundLaunchFixture(),retained=value(await f.retain());if(retained.kind!=="accepted")assert.fail();f.rows.get("40")!.archived_at=outboundNow;
 const reader=value(ClinikoOutboundLaunchRecords.createReadOnly(f.config,{allows:async q=>q.operation==="readPossibleLaunch"&&q.includeArchived===true,current:()=>true},f.port));
 const result=value(await reader.readPossibleAttempt({recallRef:retained.recallRef,actionRef:f.attempt.actionRef,patientId:f.attempt.patientId},new AbortController().signal));
 assert.equal(result.archivedAt,outboundNow);
 const denied=value(ClinikoOutboundLaunchRecords.createReadOnly(f.config,{allows:async q=>q.includeArchived!==true,current:()=>true},f.port)),before=f.calls.length;
 assert.deepEqual(await denied.readPossibleAttempt({recallRef:retained.recallRef,actionRef:f.attempt.actionRef,patientId:f.attempt.patientId},new AbortController().signal),{ok:false,error:{kind:"forbidden"}});assert.equal(f.calls.length,before);
});
test("cold archived native context preserves reserved DNC references without consuming those future actions", async () => {
  const f = await outboundLaunchFixture(), attempt = { ...f.attempt, capacityAllocationRef: randomUUID(),
    dncReferences: { actionRef: randomUUID(), approvalRef: randomUUID() } };
  const retained = value(await f.records.retainPossibleAttemptOnce(attempt, "2026-11-01", new AbortController().signal));
  assert.equal(retained.kind, "accepted"); assert.deepEqual([...f.burned], [attempt.actionRef]);
  const row = f.rows.get("40")!; row.recalled = true; row.recalled_at = outboundNow; row.archived_at = outboundNow;
  f.setNow("2026-11-03T10:00:00.000Z"); f.denyProducer();
  const reader = value(ClinikoOutboundLaunchRecords.createReadOnly(f.config, f.authority, f.port));
  const found = value(await reader.readPossibleAttempt({ recallRef: "cliniko:recall:40", actionRef: attempt.actionRef, patientId: attempt.patientId }, new AbortController().signal));
  assert.deepEqual(found.attempt.dncReferences, attempt.dncReferences); assert.equal(f.burned.has(attempt.dncReferences.actionRef), false);
  assert.equal(f.burned.has(attempt.dncReferences.approvalRef), false);
});
