import assert from "node:assert/strict";
import test from "node:test";
import { AdministrativeMemoAuthentication, encodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { ClinikoAdministrativeMemoHistory } from "../../src/cliniko/administrative-memo-history.ts";
import { administrativeMemoHistoryFixture } from "../support/administrative-memo-history.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { randomBytes, randomUUID } from "node:crypto";
const signal = () => new AbortController().signal;

for (const field of ["createdFrom", "createdThrough"] as const)
test(`undefined ${field} is not a canonical discovery window and performs no native IO`, async () => {
  const f = administrativeMemoHistoryFixture();
  assert.equal((await f.fresh().discover({ ...f.selection, [field]: undefined } as unknown as typeof f.selection, signal())).ok, false);
  assert.deepEqual(f.requests, []); assert.equal(f.claims, 0);
});

test("an undefined trusted clock cannot produce a successful cold observation", async () => {
  const f = administrativeMemoHistoryFixture(); f.state.now = undefined as unknown as string;
  assert.equal((await f.fresh().discover(f.selection, signal())).ok, false);
  assert.deepEqual(f.requests, []); assert.equal(f.claims, 0);
});

for (const archived of [false, true]) test(`cold discovery finds exact ${archived ? "archived" : "active"} original without its communication reference after response loss`, async () => {
  const f = administrativeMemoHistoryFixture(100); f.state.mode = "lostStored";
  assert.deepEqual(resultValue(await f.write.retainOnce(f.memo, signal())), { kind: "uncertain" });
  if (archived) f.rows.get("701")!.archived_at = f.state.now;
  const fresh = f.fresh(); assert.equal("retainOnce" in fresh, false); assert.equal("executeOnce" in fresh, false);
  const found = resultValue(await fresh.discover(f.selection, signal())); assert.equal(found.kind, "located");
  if (found.kind !== "located") throw Error("missing exact record");
  assert.equal(found.record.communicationRef, "cliniko:communication:701"); assert.equal(found.record.memo.sourceActionRef, f.input.sourceActionRef);
  assert.equal(found.record.archivedAt, archived ? f.state.now : null); assert.equal(found.scanned, 101);
  assert.equal(found.consistency, "twoMatchingBoundedScans"); assert.equal(f.gets, 4); assert.equal(f.claims, 5);
  assert.equal(f.queries.filter(q => q.operation === "readAdministrativeMemo" && q.memoDigest).length, 1);
  assert.equal((await f.write.retainOnce(f.memo, signal())).ok, false); assert.equal(f.requests.filter(q => q.method === "POST").length, 1);
});

test("complete not-located observation after unretained loss cannot mint another write purpose", async () => {
  const f = administrativeMemoHistoryFixture(3); f.state.mode = "lostUnstored";
  resultValue(await f.write.retainOnce(f.memo, signal())); const found = resultValue(await f.fresh().discover(f.selection, signal()));
  assert.equal(found.kind, "notLocated"); assert.equal(found.scanned, 3); assert.equal(f.gets, 2); assert.equal(f.consumed.size, 1);
  assert.equal((await f.write.retainOnce(f.memo, signal())).ok, false); assert.equal(f.requests.filter(q => q.method === "POST").length, 1);
});

for (const denied of ["collection", "record", "current"] as const)
test(`independent ${denied} grant is required for cold discovery and disclosure`, async () => {
  const f = administrativeMemoHistoryFixture(); resultValue(await f.write.retainOnce(f.memo, signal())); f.state[denied] = false;
  const before = f.claims; assert.equal((await f.fresh().discover(f.selection, signal())).ok, false);
  assert.equal(f.gets, denied === "record" ? 2 : 0); if (denied !== "record") assert.equal(f.claims, before);
  assert.equal(f.requests.filter(q => q.method === "POST").length, 1);
});

for (const corruption of ["countChange", "shortPage", "duplicateId", "foreignPatient", "foreignLink", "foreignNext", "editedContent", "wrongConfidential", "clockRollback", "sameCountReplacement"] as const)
test(`cold history refuses ${corruption} rather than declaring an absent or completed effect`, async () => {
  const f = administrativeMemoHistoryFixture(100); resultValue(await f.write.retainOnce(f.memo, signal()));
  f.state.response = (body, get) => {
    const rows = body.communications as Record<string, unknown>[];
    if (corruption === "countChange" && get === 2) body.total_entries = 102;
    if (corruption === "shortPage" && get === 1) rows.pop();
    if (corruption === "duplicateId" && get === 2) rows[0]!.id = "100";
    if (get === 2) {
      if (corruption === "foreignPatient") rows[0]!.patient = { links: { self: "https://api.au5.cliniko.com/v1/patients/322" } };
      if (corruption === "foreignLink") rows[0]!.links = { self: "https://foreign.invalid/communications/701" };
      if (corruption === "editedContent") rows[0]!.content = `Staff prefix\n${rows[0]!.content}`;
      if (corruption === "wrongConfidential") rows[0]!.confidential = false;
      if (corruption === "clockRollback") f.state.now = new Date(Date.parse(f.state.now) - 1000).toISOString();
    }
    if (corruption === "foreignNext" && get === 1) body.links = { next: "https://foreign.invalid/communications?page=2" };
    if (corruption === "sameCountReplacement" && get === 3) rows[0]!.content = "Changed unrelated human memo within second scan";
    return Response.json(body);
  };
  assert.equal((await f.fresh().discover(f.selection, signal())).ok, false);
});

test("two distinct native records for the same original action are a conflict, including archived duplicates", async () => {
  const f = administrativeMemoHistoryFixture(); resultValue(await f.write.retainOnce(f.memo, signal()));
  f.rows.set("702", { ...f.rows.get("701"), id: "702", links: { self: "https://api.au5.cliniko.com/v1/communications/702" }, archived_at: f.state.now });
  assert.deepEqual(await f.fresh().discover(f.selection, signal()), { ok: false, error: { kind: "conflict" } });
});

for (const changed of ["authentication", "policy", "source", "patient", "window", "extraReference"] as const)
test(`cold discovery refuses or scopes changed ${changed} without using a lost local reference`, async () => {
  const f = administrativeMemoHistoryFixture(); resultValue(await f.write.retainOnce(f.memo, signal()));
  const config = changed === "policy" ? { ...f.config, policy: { ...f.config.policy, version: "another" } } : f.config;
  const authentication = changed === "authentication" ? new AdministrativeMemoAuthentication(randomBytes(32)) : f.authentication;
  const selection = { ...f.selection, ...(changed === "source" ? { sourceActionRef: randomUUID() } : {}), ...(changed === "patient" ? { patientId: "322" } : {}),
    ...(changed === "window" ? { createdFrom: "2026-01-01T00:00:00.000Z" } : {}), ...(changed === "extraReference" ? { communicationRef: "cliniko:communication:701" } : {}) };
  const client = resultValue(ClinikoAdministrativeMemoHistory.create(config, authentication, f.authority, f.port));
  const found = await client.discover(selection, signal());
  if (changed === "source") { assert.ok(found.ok); assert.equal(found.value.kind, "notLocated"); }
  else assert.equal(found.ok, false);
  assert.equal(f.requests.filter(q => q.method === "POST").length, 1);
});

test("bounded 500-row native collection includes two full scans; larger histories never become absence", async () => {
  const f = administrativeMemoHistoryFixture(499); resultValue(await f.write.retainOnce(f.memo, signal()));
  const found = resultValue(await f.fresh().discover(f.selection, signal())); assert.equal(found.kind, "located"); assert.equal(found.scanned, 500); assert.equal(f.gets, 10);
  f.rows.set("800", f.makeRow("800", "Another human memo", false)); assert.equal((await f.fresh().discover(f.selection, signal())).ok, false);
});

for (const phase of ["budget", "body", "record"] as const)
test(`late revocation at ${phase} prevents disclosure without repeating a clinical or native write`, async () => {
  const f = administrativeMemoHistoryFixture(); resultValue(await f.write.retainOnce(f.memo, signal()));
  if (phase === "budget") {
    const original = f.config.rateBudget.claim; (f.config.rateBudget as { claim: typeof original }).claim = () => { f.state.current = false; return original(); };
  }
  if (phase === "body") f.state.response = body => new Response(new ReadableStream({ pull(c) { f.state.current = false; c.enqueue(new TextEncoder().encode(JSON.stringify(body))); c.close(); } }), { status: 200 });
  if (phase === "record") f.authority.allowsRecordRead = async () => { f.state.current = false; return true; };
  assert.equal((await f.fresh().discover(f.selection, signal())).ok, false); assert.equal(f.requests.filter(q => q.method === "POST").length, 1);
});

for (const boundary of ["heldPermission", "heldBody", "oversizeBody", "invalidUtf8", "native429", "quota180"] as const)
test(`whole cold-read lifetime and physical budget refuse ${boundary}`, async () => {
  const f = administrativeMemoHistoryFixture(0, boundary.startsWith("held") ? 20 : 500); resultValue(await f.write.retainOnce(f.memo, signal())); let release = () => {};
  if (boundary === "heldPermission") f.state.hold = new Promise<void>(resolve => { release = resolve; });
  if (boundary === "heldBody") f.state.response = () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 200 });
  if (boundary === "oversizeBody") f.state.response = () => new Response("x".repeat(1000001), { status: 200 });
  if (boundary === "invalidUtf8") f.state.response = () => new Response(new Uint8Array([0xff]), { status: 200 });
  if (boundary === "native429") f.state.response = () => new Response(null, { status: 429, headers: { "X-RateLimit-Reset": "2" } });
  if (boundary === "quota180") for (let n = 1; n < 180; n++) assert.equal(f.actual.claim(), null);
  try { assert.equal((await f.fresh().discover(f.selection, signal())).ok, false); } finally { release(); }
  assert.equal(f.requests.filter(q => q.method === "POST").length, 1);
});

test("unrelated signed original actions do not replace or leak into the selected memo", async () => {
  const f = administrativeMemoHistoryFixture(); resultValue(await f.write.retainOnce(f.memo, signal()));
  const original = { ...f.input, sourceActionRef: randomUUID() }; // A valid independently signed different purpose.
  const { administrativeMemoActionRef } = await import("../../src/cliniko/administrative-memo.ts");
  const memo = resultValue(f.authentication.sign({ ...original, actionRef: administrativeMemoActionRef(original.sourceActionRef)! }));
  f.rows.set("702", { ...f.makeRow("702", resultValue(encodeAdministrativeMemo(memo)), true) });
  const found = resultValue(await f.fresh().discover(f.selection, signal())); assert.ok(found.kind === "located"); assert.equal(found.record.memo.sourceActionRef, f.input.sourceActionRef);
});
