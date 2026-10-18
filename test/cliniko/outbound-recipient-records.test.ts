import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoOutboundRecipientRecords } from "../../src/cliniko/outbound-recipient-records.ts";
import { outboundRecordsFixture, value, outboundReviewDate } from "../support/outbound-records.ts";
function binding(f: Awaited<ReturnType<typeof outboundRecordsFixture>>, recallRef: string) {
  return { recallRef, actionRef: f.request.actionRef, patientId: f.request.patientId };
}
test("native request retention consumes only its record action and cold reads canonical private context", async () => {
  const f = await outboundRecordsFixture(), retained = value(await f.retain()); assert.equal(retained.kind, "accepted");
  if (retained.kind !== "accepted") return;
  assert.deepEqual([...f.burned], [f.request.actionRef]); assert.equal(f.burned.has(f.request.effectRef), false); assert.equal(f.burned.has(f.request.approvalRef), false);
  const found = value(await f.records.readRequest(binding(f, retained.recallRef), new AbortController().signal));
  assert.deepEqual(found.request, f.request); assert.equal(found.recalledAt, null); assert.equal(found.archivedAt, null);
  assert.equal(Object.isFrozen(found.request.schedule.weekdays), true); assert.equal(Object.hasOwn(found, "private_unknown"), false);
  assert.ok(f.queries.some(q => q.operation === "readRecipientRequest" && q.requestDigest));
  assert.equal(f.calls.length, 2); assert.equal(f.claims, 2);
});
test("independent record exclusion lets only one concurrent native create proceed", async () => {
  const f = await outboundRecordsFixture(), results = await Promise.all([f.retain(), f.retain()]);
  assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1);
  assert.equal(f.calls.filter(r => r.method === "POST").length, 1);
});
test("lost native acknowledgement remains uncertain and cannot be retried by a fresh record owner", async () => {
  const f = await outboundRecordsFixture({ response: async () => { throw new Error("Synthetic lost acknowledgement"); } });
  assert.deepEqual(value(await f.retain()), { kind: "uncertain" });
  const cold = value(f.make()); assert.deepEqual(await cold.retainRequestOnce(f.request, outboundReviewDate, new AbortController().signal), { ok: false, error: { kind: "alreadyClaimed" } });
  assert.equal(f.calls.length, 1); assert.equal(f.rows.size, 1);
});
test("read-only capability requires no producer and cannot be cast into a writable journal", async () => {
  const f = await outboundRecordsFixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  f.denyProducer(); const read = value(ClinikoOutboundRecipientRecords.createReadOnly(f.config, { allows: f.authority.allows, current: f.authority.current }, f.port));
  assert.equal((await read.readRequest(binding(f, retained.recallRef), new AbortController().signal)).ok, true);
  const before = f.calls.length;
  assert.deepEqual(await (read as ClinikoOutboundRecipientRecords).retainRequestOnce(f.request, outboundReviewDate, new AbortController().signal), { ok: false, error: { kind: "forbidden" } });
  assert.equal(f.calls.length, before); assert.equal(f.burned.size, 1);
});
for (const kind of ["record", "producer", "current"] as const)
  test(`independent ${kind} refusal before record exclusion permits no native request`, async () => {
    const f = await outboundRecordsFixture(); if (kind === "record") f.deny(); else if (kind === "producer") f.denyProducer(); else f.retire();
    assert.equal((await f.retain()).ok, false); assert.equal(f.burned.size, 0); assert.equal(f.calls.length, 0);
  });
test("closed and archived native markers survive cold read without becoming contact permission", async () => {
  const f = await outboundRecordsFixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  const row = f.rows.get(retained.recallRef.split(":").at(-1)!)!; row.recalled = true; row.recalled_at = "2026-11-01T10:00:00Z"; row.archived_at = "2026-11-01T10:00:00Z";
  const found = value(await f.records.readRequest(binding(f, retained.recallRef), new AbortController().signal));
  assert.equal(found.recalled, true); assert.equal(found.recalledAt, "2026-11-01T10:00:00.000Z"); assert.equal(found.archivedAt, found.recalledAt);
});
for (const patch of [{ recalled: null }, { recalled_at: undefined }, { archived_at: undefined }, { notes: "wrong-family" },
  { patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/22" } } }])
  test(`unknown or mismatched native record refuses ${JSON.stringify(patch)}`, async () => {
    const f = await outboundRecordsFixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
    Object.assign(f.rows.get(retained.recallRef.split(":").at(-1)!)!, patch);
    assert.equal((await f.records.readRequest(binding(f, retained.recallRef), new AbortController().signal)).ok, false);
  });
test("record-read permission is rechecked after the decoded private context is available", async () => {
  const f = await outboundRecordsFixture({ authority: { allows: async q => q.operation !== "readRecipientRequest" || !q.request } });
  const retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  assert.deepEqual(await f.records.readRequest(binding(f, retained.recallRef), new AbortController().signal), { ok: false, error: { kind: "forbidden" } });
});
for (const mode of ["abort", "deadline"] as const)
  test(`held record authority respects ${mode} without a late native dispatch`, { timeout: 3000 }, async t => {
    let begin!: () => void, release!: () => void; const began = new Promise<void>(resolve => { begin = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const f = await outboundRecordsFixture({ deadlineMs: 250, authority: { allows: async () => { begin(); await held; return true; } } });
    const controller = new AbortController(), cleanup = setTimeout(release, 1500); t.after(() => clearTimeout(cleanup)); t.after(release);
    const running = f.retain(controller.signal); await began; if (mode === "abort") controller.abort();
    assert.equal((await running).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.burned.size, 0);
    release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0);
  });
test("expired preparation and replacement permission methods cannot manufacture record admission", async () => {
  const f = await outboundRecordsFixture(); f.setNow(f.request.schedule.expiresAt); assert.equal((await f.retain()).ok, false); assert.equal(f.burned.size, 0);
  const g = await outboundRecordsFixture(); g.deny(); Object.assign(g.authority, { allows: async () => true });
  assert.equal((await g.retain()).ok, false); assert.equal(g.burned.size, 0);
});
test("financial-shaped or incomplete configuration cannot supply outbound record selection", async () => {
  const f = await outboundRecordsFixture();
  for (const patch of [{ outboundRecallTypeId: undefined }, { recordPolicyDigest: undefined }, { rateBudget: undefined }])
    assert.equal(ClinikoOutboundRecipientRecords.create({ ...f.config, ...patch } as unknown as typeof f.config, f.authority, f.barrier, f.port).ok, false);
  assert.equal(ClinikoOutboundRecipientRecords.create(f.config, f.authority, { ...f.barrier, matches: () => false }, f.port).ok, false);
  assert.equal(f.calls.length, 0); assert.equal(f.burned.size, 0);
});
test("foreign scope business or credential context refuses before exclusions and native dispatch", async () => {
  const f = await outboundRecordsFixture();
  for (const patch of [{ scope: { ...f.request.scope, locationId: "other" } }, { businessId: "22" }, { credentialFingerprint: "e".repeat(64) }])
    assert.equal((await f.records.retainRequestOnce({ ...f.request, ...patch }, outboundReviewDate, new AbortController().signal)).ok, false);
  assert.equal(f.calls.length, 0); assert.equal(f.burned.size, 0);
});
test("physical quota refusal after record exclusion keeps it consumed and leaves launch IDs untouched", async () => {
  const f = await outboundRecordsFixture(); Object.assign(f.config.rateBudget, { claim: async () => ({ kind: "rateLimited" as const }) });
  const records = value(f.make());
  assert.deepEqual(await records.retainRequestOnce(f.request, outboundReviewDate, new AbortController().signal), { ok: false, error: { kind: "rateLimited" } });
  assert.deepEqual([...f.burned], [f.request.actionRef]); assert.equal(f.calls.length, 0);
  assert.deepEqual(await records.retainRequestOnce(f.request, outboundReviewDate, new AbortController().signal), { ok: false, error: { kind: "alreadyClaimed" } });
});
test("producer withdrawal after exclusion cannot dispatch or restore its record action", async () => {
  let f!: Awaited<ReturnType<typeof outboundRecordsFixture>>; const consumed = new Set<string>();
  f = await outboundRecordsFixture({ barrierFactory: () => ({ matches: () => true,
    claimOnce: async ref => { const claimed = !consumed.has(ref); consumed.add(ref); f.denyProducer(); return { ok: true, value: { claimed } }; } }) });
  assert.deepEqual(await f.retain(), { ok: false, error: { kind: "forbidden" } });
  assert.deepEqual([...consumed], [f.request.actionRef]); assert.equal(f.calls.length, 0);
});
test("known exact native acknowledgement survives later authority withdrawal without admitting another action", async () => {
  let f!: Awaited<ReturnType<typeof outboundRecordsFixture>>;
  f = await outboundRecordsFixture({ response: (row, method) => { if (method === "POST") f.retire(); return Response.json(row, { status: method === "POST" ? 201 : 200 }); } });
  const retained = value(await f.retain()); assert.equal(retained.kind, "accepted"); if (retained.kind !== "accepted") assert.fail();
  assert.equal((await f.records.readRequest(binding(f, retained.recallRef), new AbortController().signal)).ok, false);
  assert.equal(f.calls.length, 1); assert.deepEqual([...f.burned], [f.request.actionRef]);
});
test("headers without a complete exact native body remain uncertain and consumed at the whole-operation deadline", { timeout: 3000 }, async () => {
  let cancelled = 0;
  const f = await outboundRecordsFixture({ deadlineMs: 250, response: () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { status: 201 }) });
  assert.deepEqual(value(await f.retain()), { kind: "uncertain" }); assert.equal(cancelled, 1);
  assert.deepEqual([...f.burned], [f.request.actionRef]); assert.equal(f.calls.length, 1);
});
test("exact cold recipient GET requests archive inclusion under independently current read permission",async()=>{
 const f=await outboundRecordsFixture(),retained=value(await f.retain());if(retained.kind!=="accepted")assert.fail();f.rows.get(retained.recallRef.split(":").at(-1)!)!.archived_at="2026-11-01T10:00:00.000Z";
 const reader=value(ClinikoOutboundRecipientRecords.createReadOnly(f.config,{allows:async q=>q.operation==="readRecipientRequest"&&q.includeArchived===true,current:()=>true},f.port));
 assert.equal(value(await reader.readRequest(binding(f,retained.recallRef),new AbortController().signal)).archivedAt,"2026-11-01T10:00:00.000Z");
 const denied=value(ClinikoOutboundRecipientRecords.createReadOnly(f.config,{allows:async q=>q.includeArchived!==true,current:()=>true},f.port)),before=f.calls.length;
 assert.deepEqual(await denied.readRequest(binding(f,retained.recallRef),new AbortController().signal),{ok:false,error:{kind:"forbidden"}});assert.equal(f.calls.length,before);
});
