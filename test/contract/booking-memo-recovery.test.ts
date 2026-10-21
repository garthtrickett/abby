import assert from "node:assert/strict";
import test from "node:test";
import { bookingMemoRecoveryFixture } from "../support/booking-memo-recovery.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { randomUUID } from "node:crypto";
const signal = () => new AbortController().signal;

for (const archived of [false, true]) test(`original native booking marker recovers its exact ${archived ? "archived" : "active"} memo after lost response`, async t => {
  const x = await bookingMemoRecoveryFixture(); t.after(x.f.close);
  if (archived) { x.row.archived_at = x.config.clock!(); x.f.memoRows[0]!.archived_at = x.config.clock!(); }
  const found = resultValue(await x.fresh().recover(x.selection, signal())); assert.equal(found.kind, "located");
  if (found.kind !== "located") assert.fail();
  assert.equal(found.record.memo.outcome.kind, "bookingConfirmed"); assert.equal(found.record.memo.outcome.appointmentRef, x.selection.appointmentRef);
  assert.equal(x.row.notes, `Abby booking ${found.record.memo.sourceActionRef}`);
  assert.deepEqual(x.calls, [`/v1/individual_appointments/${x.row.id}`, "/v1/communications", "/v1/communications", `/v1/individual_appointments/${x.row.id}`]);
  assert.ok(x.queries.some(q => q.source?.sourceActionRef === found.record.memo.sourceActionRef));
  assert.equal(x.f.posts, 1); assert.equal(x.f.memoPosts.length, 1); assert.equal(x.f.consumed.size, 1);
});

test("unretained booking memo remains not located without recreating its original purpose", async t => {
  const x = await bookingMemoRecoveryFixture("lostUnstored"); t.after(x.f.close);
  assert.equal(resultValue(await x.fresh().recover(x.selection, signal())).kind, "notLocated");
  assert.equal(x.f.posts, 1); assert.equal(x.f.memoPosts.length, 1); assert.equal(x.f.consumed.size, 1);
});

for (const state of ["cancelled_at", "deleted_at"])
test(`a later native ${state} does not erase its historical booking memo or promise a currently active appointment`, async t => {
  const x = await bookingMemoRecoveryFixture(); t.after(x.f.close); x.row[state] = x.config.clock!();
  const found = resultValue(await x.fresh().recover(x.selection, signal())); assert.equal(found.kind, "located");
  if (found.kind !== "located") assert.fail(); assert.equal(found.record.memo.outcome.kind, "bookingConfirmed");
  assert.equal(x.f.posts, 1); assert.equal(x.f.memoPosts.length, 1);
});

for (const gate of ["read", "decoded", "sourceCurrent", "collection", "record", "historyCurrent"] as const)
test(`booking memo recovery needs independently current ${gate} permission`, async t => {
  const x = await bookingMemoRecoveryFixture(); t.after(x.f.close); x.gates[gate] = false;
  assert.equal((await x.fresh().recover(x.selection, signal())).ok, false);
  if (gate === "read" || gate === "sourceCurrent") assert.equal(x.calls.length, 0);
  if (gate === "decoded" || gate === "collection" || gate === "historyCurrent") assert.equal(x.calls.length, 1);
});

for (const field of ["patient", "business", "self", "practitioner", "type", "notes", "trailing", "time", "updated", "archived", "sourceChanged", "copiedMarker"] as const)
test(`booking memo recovery refuses ${field} rather than reporting an absent or new clinical effect`, async t => {
  const x = await bookingMemoRecoveryFixture(); t.after(x.f.close);
  const native = "https://api.au5.cliniko.com/v1";
  if (field === "patient") x.row.patient = { links: { self: `${native}/patients/999` } };
  if (field === "business") x.row.business = { links: { self: `${native}/businesses/99` } };
  if (field === "self") x.row.links = { self: `${native}/individual_appointments/999` };
  if (field === "practitioner") x.row.practitioner = { links: { self: "https://elsewhere.invalid/practitioners/22" } };
  if (field === "type") x.row.appointment_type = { links: { self: `${native}/appointment_types/invalid` } };
  if (field === "notes") x.row.notes = `Human note before ${x.row.notes}`;
  if (field === "trailing") x.row.notes = `${x.row.notes}\n`;
  if (field === "time") x.row.starts_at = "2026-10-08T04:05:00.000Z";
  if (field === "updated") x.row.updated_at = "2027-10-08T04:00:00.000Z";
  if (field === "archived") x.row.archived_at = "invalid";
  if (field === "copiedMarker") { x.selection.appointmentRef = "cliniko:appointment:999"; x.row.id = "999"; x.row.links = { self: `${native}/individual_appointments/999` }; }
  if (field === "sourceChanged") x.gates.before = (path, n) => { if (path.startsWith("/v1/individual_appointments/") && n > 1) x.row.notes = `Abby booking ${randomUUID()}`; };
  assert.equal((await x.fresh().recover(x.selection, signal())).ok, false);
  assert.equal(x.f.posts, 1); assert.equal(x.f.memoPosts.length, 1);
});

test("history disclosure permission remains current during a later held source reread", async t => {
  const x = await bookingMemoRecoveryFixture(); t.after(x.f.close); let opened!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { opened = resolve; });
  let allowed = 0;
  x.gates.afterGrant = q => { if (q.source && ++allowed === 2) { x.gates.hold = new Promise<void>(resolve => { release = resolve; }); opened(); } };
  const pending = x.fresh().recover(x.selection, signal());
  try { await Promise.race([held, pending.then(() => { throw Error("Recovery ended before the held source check"); })]); x.gates.historyCurrent = false; release(); assert.equal((await pending).ok, false); }
  finally { release?.(); }
});

test("an actually held source body is cancelled even if its transport ignores the abort signal", async t => {
  const x = await bookingMemoRecoveryFixture(); t.after(x.f.close); let opened!: () => void, cancelled = false;
  const began = new Promise<void>(resolve => { opened = resolve; });
  x.gates.sourceResponse = () => new Response(new ReadableStream<Uint8Array>({ pull() { opened(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  const stop = new AbortController(), pending = x.fresh().recover(x.selection, stop.signal);
  await Promise.race([began, pending.then(() => { throw Error("Recovery ended before the held source body"); })]); stop.abort(); assert.equal((await pending).ok, false); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
});

test("an extra memo reference or missing creation boundary performs no native read", async t => {
  const x = await bookingMemoRecoveryFixture(); t.after(x.f.close);
  assert.equal((await x.fresh().recover({ ...x.selection, communicationRef: "cliniko:communication:701" } as typeof x.selection, signal())).ok, false);
  assert.equal((await x.fresh().recover({ ...x.selection, createdFrom: undefined } as unknown as typeof x.selection, signal())).ok, false);
  assert.deepEqual(x.calls, []);
});
