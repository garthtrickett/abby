import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoOutboundContactOutcomeRecords } from "../../src/cliniko/outbound-contact-outcome-records.ts";
import { encodeOutboundContactOutcome } from "../../src/cliniko/outbound-contact-outcome.ts";
import { outboundContactOutcomeFixture } from "../support/outbound-contact-outcome.ts";
import { value } from "../support/outbound-records.ts";

test("separate native outcome write claims only its stable action and exact ACK is independently readable",async()=>{
  const f=outboundContactOutcomeFixture(),retained=value(await f.retain());assert.equal(retained.kind,"accepted");if(retained.kind!=="accepted")return;
  const read=value(await f.records.readOutcome({recallRef:retained.recallRef,actionRef:f.outcome.actionRef,patientId:f.outcome.patientId},new AbortController().signal));
  assert.deepEqual(read.outcome,f.outcome);assert.deepEqual([...f.burned],[f.outcome.actionRef]);assert.equal((await f.retain()).ok,false);assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
});
test("ACK loss remains consumed and complete native history recovers the original closed archived outcome",async()=>{
  const f=outboundContactOutcomeFixture();f.state.response=(row,method)=>method==="POST"?Promise.reject(Error("synthetic lost ACK")):Response.json(row);
  const result=await f.retain();assert.ok(!result.ok||result.value.kind==="uncertain");assert.equal(f.burned.size,1);const row=f.rows.get("400")!;row.recalled=true;row.recalled_at=f.state.now;row.archived_at=f.state.now;
  const found=value(await f.find());assert.equal(found.record?.recallRef,"cliniko:recall:400");assert.deepEqual(found.record?.outcome,f.outcome);assert.equal(found.record?.archivedAt,f.state.now);
  assert.equal((await f.retain()).ok,false);assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
});
test("readonly history absence is independent of producer and contains no hidden write",async()=>{
  const f=outboundContactOutcomeFixture();f.state.producer=false;assert.deepEqual(value(await f.find()),{kind:"nativeContactOutcomeHistory",selected:0,scanned:0});assert.equal(f.burned.size,0);assert.equal(f.calls.some(c=>c.method==="POST"),false);
  const reader=value(ClinikoOutboundContactOutcomeRecords.createReadOnly(f.config,f.authority,f.native));assert.equal("retainOutcomeOnce" in reader,false);
});
for(const denial of ["producer","broad","private","current"]as const)test(`independent outcome ${denial} denial stays unavailable`,async()=>{
  const f=outboundContactOutcomeFixture();if(denial==="producer"){f.state.producer=false;assert.equal((await f.retain()).ok,false);assert.equal(f.calls.length,0);return;}
  value(await f.retain());f.state.grant=q=>denial==="broad"?q.operation!=="readContactOutcomeHistory":denial==="private"?q.operation!=="readContactOutcome":true;
  if(denial==="current")f.state.live=false;assert.equal((await f.find()).ok,false);
});
test("duplicate native action, conflicting original context and a changed second scan cannot be hidden",async()=>{
  for(const mode of ["duplicate","context","changedScan"]as const){const f=outboundContactOutcomeFixture();value(await f.retain());const row=f.rows.get("400")!;
    if(mode==="duplicate")f.rows.set("401",{...row,id:"401",links:{self:"https://api.au5.cliniko.com/v1/recalls/401"}});
    if(mode==="context")row.notes=value(encodeOutboundContactOutcome({...f.outcome,attempt:{...f.outcome.attempt,digest:"f".repeat(64)}}));
    if(mode==="changedScan"){let pages=0;f.state.page=rows=>{pages++;return Response.json({recalls:pages>1?[]:rows,total_entries:pages>1?0:rows.length});};}
    assert.equal((await f.find()).ok,false);
  }
});
test("wrong native type, invalid dates, unknown family and oversized history cannot turn into absent settlement",async()=>{
  for(const mode of ["type","date","version","bounds"]as const){const f=outboundContactOutcomeFixture();value(await f.retain());const row=f.rows.get("400")!;
    if(mode==="type")f.state.response=row=>Response.json({...row,recall_type:{links:{self:"https://api.au5.cliniko.com/v1/recall_types/99"}}});
    if(mode==="date")row.updated_at="bad";if(mode==="version")row.notes=String(row.notes).replace("outcome v1","outcome v2");
    if(mode==="bounds")f.state.page=()=>Response.json({recalls:[],total_entries:501});assert.equal((await f.find()).ok,false);
  }
});
test("captured history grants and exact binding cannot change while awaiting private read",async()=>{
  const f=outboundContactOutcomeFixture();value(await f.retain());let changed=false;
  f.state.grant=q=>{if(q.operation==="readContactOutcome"&&q.outcome&&!changed){changed=true;f.state.live=false;}return true;};
  assert.equal((await f.find()).ok,false);assert.ok(changed);
  const fake={...f.possible,attempt:{...f.possible.attempt,contactReferences:{...f.possible.attempt.contactReferences!,outcomeActionRef:randomUUID()}}};
  f.state.live=true;assert.equal((await f.history().findForAttempt(fake,new AbortController().signal)).ok,false);
});
