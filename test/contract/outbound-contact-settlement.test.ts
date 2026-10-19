import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { outboundContactSettlementFixture } from "../support/outbound-contact-settlement.ts";
import { value } from "../support/outbound-records.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { outboundContactOutcomeValue } from "../support/outbound-contact-outcome.ts";
import { encodeOutboundContactOutcome, decodeOutboundContactOutcome } from "../../src/cliniko/outbound-contact-outcome.ts";
import { ClinikoOutboundContactSettlement } from "../../src/standalone/cliniko-outbound-contact-settlement.ts";

for(const stopped of [false,true])test(`actual native contact settlement ${stopped?"retains restrictive DNC first":"requires complete no-stop truth"} before releasing only contact hold`,async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);if(stopped)f.settlementState.contact="stopRequested";
  const result=value(await f.settle());assert.equal(result.kind,"nativeContactOutcomeRetained");if(result.kind!=="nativeContactOutcomeRetained")return;
  assert.equal(result.contactHold,"released");assert.equal(f.contactHeld.size,0);assert.equal(f.held.size,1,"call concurrency remains independently owned");
  assert.equal(f.outcomePosts.length,1);assert.equal(f.dncPosts.length,stopped?1:0);assert.equal(f.calls.length,1,"settlement never initiates another call");
  const outcome=value(decodeOutboundContactOutcome(f.outcomePosts[0]!.notes));assert.equal(outcome.actionRef,f.attempt.contactReferences?.outcomeActionRef);
  assert.equal(outcome.result.kind,stopped?"stopRetained":"completeNoStop");assert.ok(f.burned.has(f.request.effectRef));
});
for(const mode of ["contact","terminal","wrongEffect","wrongProvider","wrongNumber","incomplete","history","producer","record","grant"]as const)
  test(`unknown, unauthenticated or denied ${mode} evidence never releases contact hold`,async t=>{
    const f=await outboundContactSettlementFixture();t.after(f.close);
    if(mode==="contact")f.settlementState.complete=false;if(mode==="terminal")f.settlementState.terminal=false;
    if(mode==="wrongEffect")f.settlementState.reportPatch={effectRef:randomUUID()};if(mode==="wrongProvider")f.settlementState.reportPatch={provider:{...f.providerBinding,bindingDigest:"f".repeat(64)}};
    if(mode==="wrongNumber"){f.settlementState.contact="stopRequested";f.settlementState.reportPatch={stop:{kind:"stop",effectRef:f.attempt.effectRef,capacityAllocationRef:f.attempt.capacityAllocationRef,provider:f.providerBinding,number:"+12025550999",participant:"anyAtDialledNumber",stoppedAt:f.state.now,observedAt:f.state.now}};}
    if(mode==="incomplete")f.settlementState.reportPatch={complete:false};if(mode==="history")f.settlementState.history=false;
    if(mode==="producer")f.settlementState.producer=false;if(mode==="record")f.settlementState.record=false;if(mode==="grant")f.settlementState.allowed=false;
    const result=await f.settle();assert.ok(!result.ok||result.value.kind==="held"||result.value.contactHold==="releaseUnconfirmed");
    assert.equal(f.contactHeld.size,1);assert.equal(f.held.size,1);assert.equal(f.calls.length,1);
  });
test("uncertain DNC ACK stays held and cold native recovery writes neither decision nor outcome twice",async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);f.settlementState.contact="stopRequested";
  f.stopState.response=()=>Promise.reject(Error("synthetic DNC acknowledgement lost"));
  assert.equal(value(await f.settle()).kind,"held");assert.equal(f.contactHeld.size,1);assert.equal(f.dncPosts.length,1);assert.equal(f.outcomePosts.length,0);
  delete f.stopState.response; f.state.now="2026-11-02T00:02:00.000Z";
  const done=value(await value(f.make()).settleOnce(f.stopBinding,new AbortController().signal));assert.equal(done.kind,"nativeContactOutcomeRetained");
  if(done.kind==="nativeContactOutcomeRetained")assert.equal(done.contactHold,"released");
  assert.equal(f.dncPosts.length,1);assert.equal(f.outcomePosts.length,1);assert.equal(f.contactHeld.size,0);
});
test("uncertain settlement ACK holds contact and a cold owner recovers the exact archived native receipt",async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);f.settlementState.response=()=>Promise.reject(Error("synthetic outcome acknowledgement lost"));
  assert.equal(value(await f.settle()).kind,"held");assert.equal(f.contactHeld.size,1);assert.equal(f.outcomePosts.length,1);
  const row=f.contactControls.rows.find(row=>row.id==="400")!;row.recalled=true;row.recalled_at=f.state.now;row.archived_at=f.state.now;
  delete f.settlementState.response;const done=value(await value(f.make()).settleOnce(f.stopBinding,new AbortController().signal));
  assert.equal(done.kind,"nativeContactOutcomeRetained");if(done.kind==="nativeContactOutcomeRetained")assert.equal(done.contactHold,"released");
  assert.equal(f.outcomePosts.length,1);assert.equal(f.contactHeld.size,0);assert.equal(f.calls.length,1);
});
test("known exact native ACK remains retained if permission disappears before release",async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);
  f.settlementState.beforeGrant=q=>{if(q.operation==="releaseContactHold")f.settlementState.live=false;};
  assert.deepEqual(value(await f.settle()),{kind:"nativeContactOutcomeRetained",recallRef:"cliniko:recall:400",contactHold:"releaseUnconfirmed"});
  assert.equal(f.contactHeld.size,1);assert.equal(f.outcomePosts.length,1);
});
test("an edited native outcome cannot clear a hold against changed authenticated provider truth",async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);f.settlementState.response=()=>Promise.reject(Error("synthetic lost receipt"));value(await f.settle());
  delete f.settlementState.response;f.settlementState.reportPatch={reportDigest:"f".repeat(64)};
  assert.equal((await value(f.make()).settleOnce(f.stopBinding,new AbortController().signal)).ok,false);assert.equal(f.contactHeld.size,1);assert.equal(f.outcomePosts.length,1);
});
test("a changed provider report after native retention cannot authorize contact release",async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);let reads=0;
  f.settlementState.beforeReport=()=>{reads++;if(reads>1)f.settlementState.complete=false;};
  assert.deepEqual(value(await f.settle()),{kind:"nativeContactOutcomeRetained",recallRef:"cliniko:recall:400",contactHold:"releaseUnconfirmed"});
  assert.equal(f.contactHeld.size,1);
});
test("captured provider, grant and account methods cannot be replaced to reverse a refusal",async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);f.settlementState.allowed=false;
  Object.assign(f.ports.authority,{allows:async()=>true,current:()=>true});Object.assign(f.ports.provider,{inspectContact:async()=>({kind:"unknown"})});
  assert.equal((await f.settle()).ok,false);assert.equal(f.contactHeld.size,1);assert.equal(f.outcomePosts.length,0);
});
test("cross-role aliases, inadequate full cost and a different guard source are rejected",async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);
  assert.equal(ClinikoOutboundContactSettlement.create({...f.config,outcomes:{...f.config.outcomes,outboundContactOutcomeRecallTypeId:"62"}},f.ports).ok,false);
  assert.equal(ClinikoOutboundContactSettlement.create({...f.config,maximumNativeRequests:60},f.ports).ok,false);
  assert.equal(ClinikoOutboundContactSettlement.create({...f.config,guardRef:randomUUID()},f.ports).ok,false);
  await f.replaceAccount({enabled:false});assert.equal((await f.settle()).ok,false);assert.equal(f.contactHeld.size,1);
});

for(const mode of ["selectedCapacity","fullCost"]as const)test(`complete native history ${mode} refuses before either new mutation`,async t=>{
  const f=await outboundContactSettlementFixture();t.after(f.close);f.settlementState.contact="stopRequested";
  const count=mode==="selectedCapacity"?50:49,base="https://api.au5.cliniko.com/v1";
  for(let i=0;i<count;i++){
    const {outcome}=outboundContactOutcomeValue(clinikoCredentialFingerprint(f.config.outcomes.apiKey));
    const prior={...outcome,attempt:{...outcome.attempt,recallRef:`cliniko:recall:${9000+i}`}};
    const id=String(1000+i);f.contactControls.rows.push({id,links:{self:`${base}/recalls/${id}`},patient:{links:{self:`${base}/patients/${f.attempt.patientId}`}},
      recall_type:{links:{self:`${base}/recall_types/63`}},notes:value(encodeOutboundContactOutcome(prior)),recall_at:"2026-11-02",created_at:prior.recordedAt,updated_at:prior.recordedAt,recalled:false,recalled_at:null,archived_at:null});
  }
  if(mode==="fullCost"){
    let n=2000;
    while(f.contactControls.rows.length<499){const id=String(n++);f.contactControls.rows.push({id,links:{self:`${base}/recalls/${id}`},patient:{links:{self:`${base}/patients/${f.attempt.patientId}`}},
      recall_type:{links:{self:`${base}/recall_types/99`}},notes:"unrelated native clinical record",recall_at:"2026-11-02",created_at:f.state.now,updated_at:f.state.now,recalled:false,recalled_at:null,archived_at:null});}
  }
  assert.deepEqual(value(await f.settle()),{kind:"held"});assert.equal(f.contactHeld.size,1);assert.equal(f.outcomePosts.length,0);assert.equal(f.dncPosts.length,0);
});
