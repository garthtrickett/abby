import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoOutboundPendingDiscovery } from "../../src/cliniko/outbound-pending-discovery.ts";
import { encodeOutboundRecipientRequest, outboundRecipientRequestDigest } from "../../src/cliniko/outbound-recipient-request.ts";
import { outboundPendingFixture } from "../support/outbound-pending.ts";
import { outboundNow, value } from "../support/outbound-records.ts";
const row = (f: Awaited<ReturnType<typeof outboundPendingFixture>>) => f.controls.rows[0]!;
function accountRows(f: Awaited<ReturnType<typeof outboundPendingFixture>>, count: number) {
  const original = row(f);
  f.controls.rows = Array.from({ length: count }, (_,i) => ({ ...structuredClone(original), id: String(30+i),
    links: { self: `https://api.au5.cliniko.com/v1/recalls/${30+i}` }, ...(i ? { recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/99" } }, notes: null } : {}) }));
}
test("pending discovery requires independent collection and exact decoded-record authority without producer or journal", async () => {
  const f = await outboundPendingFixture(), before = f.f.claims; f.f.denyProducer();
  const result = value(await f.scan()); assert.equal(result.kind, "pendingRecipientContext"); assert.equal(result.scanned, 1); assert.equal(result.observedAt, outboundNow);
  assert.equal(result.records.length, 1); assert.deepEqual(result.records[0]!.request, f.f.request); assert.equal(Object.hasOwn(result.records[0]!, "private_unknown"), false);
  assert.equal(f.calls.length, 2); assert.equal(f.f.claims-before, 2); assert.equal(f.f.burned.size, 1);
  assert.ok(f.accountQueries.every(q => q.includeArchived === false && q.unrecalledAtOnly && q.ownerBinding === f.f.binding));
  assert.ok(f.recordQueries.some(q => q.requestDigest === outboundRecipientRequestDigest(f.f.request)));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.records) && Object.isFrozen(result.records[0]!.request));
});
for (const denied of ["account", "record"] as const) test(`independent ${denied} denial reveals no private result or native writes`, async () => {
  const f = await outboundPendingFixture(); if (denied === "account") f.denyAccount(); else f.denyRecord();
  assert.deepEqual(await f.scan(), { ok: false, error: { kind: "forbidden" } });
  assert.equal(f.calls.length, denied === "account" ? 0 : 1); assert.equal(f.f.burned.size, 1);
});
test("empty bounded pending result is an observation without patient disclosure or record claims", async () => {
  const f = await outboundPendingFixture(); f.controls.rows = [];
  assert.deepEqual(value(await f.scan()), { kind: "pendingRecipientContext", scanned: 0, observedAt: outboundNow, records: [] });
  assert.equal(f.calls.length, 1); assert.equal(f.recordQueries.length, 0);
});
for (const count of [100,101,500]) test(`complete ${count}-row account scan discards unrelated records under the collection grant`, async () => {
  const f = await outboundPendingFixture(); accountRows(f,count); const before = f.f.claims;
  const result = value(await f.scan()); assert.equal(result.scanned,count); assert.equal(result.records.length,1);
  assert.equal(f.calls.length,Math.ceil(count/100)+1); assert.equal(f.f.claims-before,f.calls.length);
});
for (const change of ["overBound", "negative", "fraction", "missingRows", "badOrder", "foreignSelf", "foreignPatient", "missingArchived", "unknownRecalled", "closed", "futureUpdated", "badNotes"] as const)
  test(`pending collection refuses ${change} instead of returning partial context`, async () => {
    const f = await outboundPendingFixture(), r = row(f);
    if (change === "overBound") f.controls.total=501;
    if (change === "negative") f.controls.total=-1;
    if (change === "fraction") f.controls.total=1.5;
    if (change === "missingRows") f.controls.total=2;
    if (change === "badOrder") f.controls.rows=[r,structuredClone(r)];
    if (change === "foreignSelf") r.links={ self: "https://other.invalid/recalls/30" };
    if (change === "foreignPatient") r.patient={ links: { self: "https://api.au4.cliniko.com/v1/patients/8" } };
    if (change === "missingArchived") delete r.archived_at;
    if (change === "unknownRecalled") r.recalled=null;
    if (change === "closed") r.recalled_at=outboundNow;
    if (change === "futureUpdated") r.updated_at="2026-11-01T10:01:00.000Z";
    if (change === "badNotes") r.notes="unrecognized private native content";
    const result = await f.scan(); assert.equal(result.ok,false); assert.equal(f.calls.length,1); assert.equal(f.f.burned.size,1);
  });
test("changed totals across pages refuse even when every returned page is individually shaped", async () => {
  const f = await outboundPendingFixture(); accountRows(f,101);
  f.controls.page=(rows,page)=>Response.json({ recalls: rows,total_entries: page===1?101:102 });
  assert.equal((await f.scan()).ok,false); assert.equal(f.calls.length,2);
});
for (const change of ["note", "closed", "archived", "updated", "reviewDate"] as const) test(`exact reread refuses ${change} mutation after listing`, async () => {
  const f = await outboundPendingFixture(); f.controls.get = original => {
    const r = structuredClone(original);
    if (change === "note") r.notes=value(encodeOutboundRecipientRequest({ ...f.f.request, recipient: { kind: "voice", number: "+61411111111" } }));
    if (change === "closed") { r.recalled=true;r.recalled_at=outboundNow; }
    if (change === "archived") r.archived_at=outboundNow;
    if (change === "updated") r.updated_at="2026-11-01T10:00:01.000Z";
    if (change === "reviewDate") r.recall_at="2026-11-03";
    return Response.json(r);
  };
  assert.deepEqual(await f.scan(),{ ok:false,error:{ kind:"mismatched" } }); assert.equal(f.calls.length,2);
});
for (const repeat of [false,true]) test(`one campaign permits distinct recipient actions but ${repeat?"refuses":"does not merge"} reused launch IDs`, async () => {
  const f = await outboundPendingFixture(), original = row(f);
  const request = { ...f.f.request, actionRef: randomUUID(), approvalRef: randomUUID(), effectRef: repeat?f.f.request.effectRef:randomUUID() };
  const second={ ...structuredClone(original),id:"31",links:{self:"https://api.au5.cliniko.com/v1/recalls/31"},notes:value(encodeOutboundRecipientRequest(request)) };
  f.controls.rows.push(second);f.f.rows.set("31",second);
  const result=await f.scan(); if(repeat) assert.deepEqual(result,{ok:false,error:{kind:"mismatched"}});
  else { const found=value(result);assert.equal(found.records.length,2);assert.equal(found.records[0]!.request.campaignRef,found.records[1]!.request.campaignRef); }
});
test("decoded private context needs renewed permission before any result is disclosed", async () => {
  const f=await outboundPendingFixture();f.authority.allowsRecordRead=async q=>q.requestDigest===undefined;
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"forbidden"}});assert.equal(f.calls.length,2);
});
test("account authority withdrawn during exact native read prevents returning previously loaded context", async () => {
  const f=await outboundPendingFixture();f.controls.get=r=>{f.retire();return Response.json(r);};
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"forbidden"}});
});
test("physical rate refusal prevents collection GET without acquiring another exclusion", async () => {
  const f=await outboundPendingFixture();f.f.config.rateBudget.claim=async()=>({kind:"rateLimited"});
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"rateLimited"}});assert.equal(f.calls.length,0);assert.equal(f.f.burned.size,1);
});
test("native429 is observed by the shared physical budget and yields no partial result", async () => {
  const f=await outboundPendingFixture();let observed=0;f.f.config.rateBudget.observe429=async()=>{observed++;return {kind:"rateLimited"};};
  f.controls.page=()=>new Response(null,{status:429,headers:{"X-RateLimit-Reset":"123"}});
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"rateLimited"}});assert.equal(observed,1);
});
for (const stage of ["grant","headers","body"] as const) test(`whole discovery deadline bounds held ${stage} and consumes no action`, {timeout:3000},async()=>{
  const f=await outboundPendingFixture({deadlineMs:100});let cancelled=0;
  if(stage==="grant")f.authority.allowsPendingRead=()=>new Promise(()=>{});
  if(stage==="headers")f.controls.page=()=>new Promise(()=>{});
  if(stage==="body")f.controls.page=()=>new Response(new ReadableStream({cancel(){cancelled++;}}));
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"unavailable"}});if(stage==="body")assert.equal(cancelled,1);assert.equal(f.f.burned.size,1);
});
test("backwards trusted clock during provider completion refuses pending context",async()=>{
  const f=await outboundPendingFixture();f.controls.page=rows=>{f.f.setNow("2026-11-01T09:59:59.000Z");return Response.json({recalls:rows,total_entries:1});};
  assert.deepEqual(await f.scan(),{ok:false,error:{kind:"unavailable"}});
});
test("configuration and bound permission methods cannot be replaced after discovery creation",async()=>{
  const f=await outboundPendingFixture();f.denyAccount();const discovery=value(f.make());f.authority.allowsPendingRead=async()=>true;
  assert.deepEqual(await discovery.scanPending(new AbortController().signal),{ok:false,error:{kind:"forbidden"}});assert.equal(f.calls.length,0);
  assert.equal(ClinikoOutboundPendingDiscovery.create({...f.f.config,outboundRecallTypeId:""},f.authority,f.port).ok,false);
});
