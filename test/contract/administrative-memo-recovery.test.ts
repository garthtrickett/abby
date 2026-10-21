import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoAdministrativeMemoRecovery } from "../../src/standalone/cliniko-administrative-memo-recovery.ts";
import { decodeClinikoReview, encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { classBookingMemoFixture } from "../support/class-booking-memo.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

async function fixture() {
  const f = await classBookingMemoFixture({ admitted: true, mode: "lostStored" });
  try {
    await f.prepare(); await f.drain();
    const config = f.classSessionConfig.memo!.native, now = config.clock!();
    const row: Record<string, unknown> & { links: { self: string } } = { ...f.recalls[0], links: { self: "https://api.au5.cliniko.com/v1/recalls/71" }, updated_at: now };
    const calls: string[] = [], grants = { original: true, history: true, record: true, current: true,
      hold: undefined as Promise<void> | undefined, after: undefined as (() => void) | undefined,
      originalResponse: undefined as (() => Response) | undefined };
    const port: typeof fetch = async (url, init) => {
      assert.equal(init?.method, "GET"); calls.push(new URL(String(url)).pathname);
      if (calls.at(-1) === "/v1/recalls/71") return grants.originalResponse?.() ?? Response.json(row);
      assert.equal(calls.at(-1), "/v1/communications");
      grants.after?.();
      return Response.json({ communications: f.memoRows, total_entries: f.memoRows.length });
    };
    const fresh = () => resultValue(ClinikoAdministrativeMemoRecovery.create(config, f.authentication, "7",
      { allows: async q => { assert.equal(q.recallRef, "cliniko:recall:71"); await grants.hold; return grants.original; }, current: () => grants.current },
      { allowsHistoryRead: async () => grants.history, allowsRecordRead: async () => grants.record, current: () => true }, port));
    const selection = { patientId: verificationCanaries[2]!, recallRef: "cliniko:recall:71",
      createdFrom: new Date(Date.parse(now) - 3600000).toISOString(), createdThrough: now };
    return { f, row, calls, grants, fresh, selection };
  } catch (error) { await f.close(); throw error; }
}

test("fresh protected recovery derives the class purpose from its actual native review, without a communication ID or another POST", async t => {
  const x = await fixture(); t.after(x.f.close);
  const result = resultValue(await x.fresh().recover(x.selection, new AbortController().signal));
  assert.equal(result.kind, "located"); assert.equal(result.scanned, 1);
  if (result.kind !== "located") assert.fail();
  const original = resultValue(decodeClinikoReview(x.row.notes)); assert.equal(original.request.operation.kind, "classBook");
  assert.equal(result.record.memo.sourceActionRef, original.request.operation.attendanceActionId);
  assert.equal(result.record.memo.outcome.kind, "classBookingConfirmed");
  assert.deepEqual(x.calls, ["/v1/recalls/71", "/v1/communications", "/v1/communications"]);
  assert.equal(x.f.writes.length, 1); assert.equal(x.f.memoPosts.length, 1); assert.equal(x.f.consumed.size, 1);
});

for (const gate of ["original", "history", "record"] as const)
test(`original-review recovery requires its separate ${gate} permission`, async t => {
  const x = await fixture(); t.after(x.f.close); x.grants[gate] = false;
  assert.equal((await x.fresh().recover(x.selection, new AbortController().signal)).ok, false);
  if (gate === "original") assert.deepEqual(x.calls, []);
  if (gate === "history") assert.deepEqual(x.calls, ["/v1/recalls/71"]);
});

for (const field of ["patient", "location", "account", "operation", "reviewType", "nativeLink"] as const)
test(`original-review recovery rejects a changed ${field} without disclosing a memo`, async t => {
  const x = await fixture(); t.after(x.f.close);
  if (field === "patient") x.selection.patientId = "999";
  else if (field === "nativeLink") x.row.links.self = "https://elsewhere.invalid/v1/recalls/71";
  else if (field === "reviewType") Object.assign(x.row, { recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/8" } } });
  else {
    // The review codec is deliberately strict: editing either the bound
    // scope/account or the canonical operation must not supply a source.
    const old = String(x.row.notes);
    const needle = field === "location" ? '"locationId":"main"' : field === "account" ? '"businessId":"11"' : '"sessionId":"94"';
    assert.ok(old.includes(needle));
    x.row.notes = old.replace(needle, field === "location" ? '"locationId":"other"' : field === "account" ? '"businessId":"99"' : '"sessionId":"95"');
  }
  assert.equal((await x.fresh().recover(x.selection, new AbortController().signal)).ok, false);
  if (field !== "operation") assert.ok(!x.calls.includes("/v1/communications"));
});

test("original-review permission is rechecked after both native history scans", async t => {
  const x = await fixture(); t.after(x.f.close); x.grants.after = () => { x.grants.current = false; };
  assert.equal((await x.fresh().recover(x.selection, new AbortController().signal)).ok, false);
});

test("a held original permission is bounded and performs no native read after cancellation", async t => {
  const x = await fixture(); t.after(x.f.close); let release!: () => void;
  x.grants.hold = new Promise<void>(resolve => { release = resolve; }); const stop = new AbortController();
  try {
    const pending = x.fresh().recover(x.selection, stop.signal); stop.abort(); assert.equal((await pending).ok, false);
    release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(x.calls, []);
  } finally { release(); }
});

test("a caller-supplied communication reference is never accepted as original-review authority", async t => {
  const x = await fixture(); t.after(x.f.close);
  assert.equal((await x.fresh().recover({ ...x.selection, communicationRef: "cliniko:communication:701" } as typeof x.selection, new AbortController().signal)).ok, false);
  assert.deepEqual(x.calls, []);
});

test("cancelling an original-review read retires its owned body even when the transport ignores abort", async t => {
  const x = await fixture(); t.after(x.f.close); let opened!: () => void, controller!: ReadableStreamDefaultController<Uint8Array>, cancelled = false;
  const bodyOpened = new Promise<void>(resolve => { opened = resolve; });
  x.grants.originalResponse = () => new Response(new ReadableStream<Uint8Array>({
    start(c) { controller = c; opened(); }, cancel() { cancelled = true; }
  }));
  const stop = new AbortController();
  try {
    const pending = x.fresh().recover(x.selection, stop.signal); await bodyOpened; stop.abort();
    assert.equal((await pending).ok, false); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cancelled, true); assert.deepEqual(x.calls, ["/v1/recalls/71"]);
  } finally { if (!cancelled) controller.close(); }
});

test("an invalid discovery window cannot initiate an original native read", async t => {
  const x = await fixture(); t.after(x.f.close);
  assert.equal((await x.fresh().recover({ ...x.selection, createdThrough: "invalid" }, new AbortController().signal)).ok, false);
  assert.deepEqual(x.calls, []);
});

for (const field of ["createdFrom", "createdThrough"] as const)
test(`undefined original-review ${field} performs no protected native read`, async t => {
  const x = await fixture(); t.after(x.f.close);
  assert.equal((await x.fresh().recover({ ...x.selection, [field]: undefined } as unknown as typeof x.selection, new AbortController().signal)).ok, false);
  assert.deepEqual(x.calls, []);
});

test("a native individual booking review cannot invent the absent original booking marker", async t => {
  const x = await fixture(); t.after(x.f.close); const original = resultValue(decodeClinikoReview(x.row.notes));
  assert.equal(original.request.operation.kind, "classBook"); const o = original.request.operation;
  x.row.notes = resultValue(encodeClinikoReview(original.marker, { ...original.request,
    operation: { kind: "book", practitionerId: o.practitionerId, appointmentTypeId: o.appointmentTypeId, startsAt: o.startsAt, endsAt: o.endsAt } }));
  assert.equal((await x.fresh().recover(x.selection, new AbortController().signal)).ok, false);
  assert.deepEqual(x.calls, ["/v1/recalls/71"]);
});
