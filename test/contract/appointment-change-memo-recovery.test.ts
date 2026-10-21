import assert from "node:assert/strict";
import test from "node:test";
import { appointmentChangeMemoFixture } from "../support/appointment-change-memo.ts";
import { ClinikoAdministrativeMemoRecovery } from "../../src/standalone/cliniko-administrative-memo-recovery.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { decodeClinikoReview, encodeClinikoReview } from "../../src/cliniko/review-request.ts";

async function fixture(kind: "cancel" | "reschedule", mode: "lostStored" | "lostUnstored" = "lostStored") {
  const f = await appointmentChangeMemoFixture(kind, { mode });
  try {
    await f.prepare(); await f.drain(); const now = f.native.clock();
    const row: Record<string, unknown> = { ...f.recalls[0], links: { self: "https://api.au5.cliniko.com/v1/recalls/71" }, updated_at: now };
    const calls: string[] = [], gates = { source: true, history: true, record: true, current: true };
    const port: typeof fetch = async (value, init) => {
      const url = new URL(String(value)); assert.equal(init?.method, "GET"); calls.push(url.pathname);
      if (url.pathname === "/v1/recalls/71") { assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*"]); return Response.json(row); }
      assert.equal(url.pathname, "/v1/communications"); return Response.json({ communications: f.memoRows, total_entries: f.memoRows.length });
    };
    const fresh = () => resultValue(ClinikoAdministrativeMemoRecovery.create(f.native, f.authentication, "7",
      { allows: async query => gates.source && query.includeArchived, current: () => gates.current },
      { allowsHistoryRead: async () => gates.history, allowsRecordRead: async () => gates.record, current: () => gates.current }, port));
    const selection = { patientId: verificationCanaries[2]!, recallRef: "cliniko:recall:71",
      createdFrom: new Date(Date.parse(now) - 3600000).toISOString(), createdThrough: now };
    return { f, row, calls, gates, fresh, selection };
  } catch (error) { await f.close(); throw error; }
}

for (const kind of ["cancel", "reschedule"] as const) for (const archived of [false, true])
test(`actual admitted ${kind} memo recovers its historical observed result from a ${archived ? "closed archived" : "pending"} native review`, async t => {
  const x = await fixture(kind); t.after(x.f.close);
  if (archived) { x.row.archived_at = x.f.native.clock(); x.row.recalled = true; x.f.memoRows[0]!.archived_at = x.f.native.clock(); }
  const found = resultValue(await x.fresh().recover(x.selection, new AbortController().signal)); assert.equal(found.kind, "located");
  if (found.kind !== "located") assert.fail();
  assert.equal(found.record.memo.sourceActionRef, resultValue(decodeClinikoReview(x.row.notes)).marker);
  assert.equal(found.record.memo.outcome.kind, kind === "cancel" ? "cancellationObserved" : "reschedulingObserved");
  if (found.record.memo.outcome.kind !== "cancellationObserved" && found.record.memo.outcome.kind !== "reschedulingObserved") assert.fail();
  assert.equal(found.record.memo.outcome.verification.basis, "acknowledgedAndObservedBestEffort");
  assert.equal(x.f.patches, 1); assert.equal(x.f.memoPosts.length, 1); assert.equal(x.f.consumed.size, 1);
});

for (const kind of ["cancel", "reschedule"] as const)
test(`unretained ${kind} memo stays not located and cannot repeat its clinical effect`, async t => {
  const x = await fixture(kind, "lostUnstored"); t.after(x.f.close);
  assert.equal(resultValue(await x.fresh().recover(x.selection, new AbortController().signal)).kind, "notLocated");
  assert.equal(x.f.patches, 1); assert.equal(x.f.memoPosts.length, 1); assert.equal(x.f.consumed.size, 1);
});

for (const kind of ["cancel", "reschedule"] as const) for (const denied of ["source", "history", "record", "current"] as const)
test(`actual ${kind} source cannot replace its independent ${denied} recovery grant`, async t => {
  const x = await fixture(kind); t.after(x.f.close); x.gates[denied] = false;
  assert.equal((await x.fresh().recover(x.selection, new AbortController().signal)).ok, false);
  if (denied === "source" || denied === "current") assert.deepEqual(x.calls, []);
});

for (const kind of ["cancel", "reschedule"] as const)
test(`edited canonical ${kind} original context cannot promote a different interval's memo`, async t => {
  const x = await fixture(kind); t.after(x.f.close); const original = resultValue(decodeClinikoReview(x.row.notes));
  assert.ok(original.request.operation.kind === "cancel" || original.request.operation.kind === "reschedule");
  x.row.notes = resultValue(encodeClinikoReview(original.marker, { ...original.request,
    operation: { ...original.request.operation, startsAt: "2026-10-08T04:05:00.000Z" } }));
  assert.equal((await x.fresh().recover(x.selection, new AbortController().signal)).ok, false);
  assert.equal(x.f.patches, 1); assert.equal(x.f.memoPosts.length, 1);
});
