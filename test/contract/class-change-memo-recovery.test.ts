import assert from "node:assert/strict";
import test from "node:test";
import { classCancellationMemoFixture } from "../support/class-cancellation-memo.ts";
import { classMovementMemoFixture } from "../support/class-movement-memo.ts";
import { ClinikoAdministrativeMemoRecovery } from "../../src/standalone/cliniko-administrative-memo-recovery.ts";
import { decodeClinikoReview, encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

type Kind = "cancel" | "move" | "partial";
async function fixture(kind: Kind, passes = false, mode: "lostStored" | "lostUnstored" = "lostStored") {
  const f = kind === "cancel" ? await classCancellationMemoFixture({ ...(passes ? { passes: "releaseOne" } : {}), mode }) :
    await classMovementMemoFixture({ passes, admitted: true, mode });
  try {
    if ("initial" in f) {
      const action = await f.initial();
      if (kind === "partial") { await f.pause(61); f.host.dispose(); }
      else for (const _ of passes ? ["original", "association", "associationInspection"] : ["original"]) await f.next(action.key);
    } else { await f.prepare(); await f.drainClinical(); }
    await f.memoSettled;
    const native = f.classSessionConfig.memo!.native, now = native.clock!();
    const row: Record<string, unknown> = { ...f.recalls[0], links: { self: "https://api.au5.cliniko.com/v1/recalls/71" }, updated_at: now };
    const calls: string[] = [], gates = { source: true, history: true, record: true, current: true };
    const port: typeof fetch = async (value, init) => {
      const url = new URL(String(value)); assert.equal(init?.method, "GET"); calls.push(url.pathname);
      if (url.pathname === "/v1/recalls/71") { assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*"]); return Response.json(row); }
      assert.equal(url.pathname, "/v1/communications"); return Response.json({ communications: f.memoRows, total_entries: f.memoRows.length });
    };
    const fresh = () => resultValue(ClinikoAdministrativeMemoRecovery.create(native, f.authentication, "7",
      { allows: async query => gates.source && query.includeArchived, current: () => gates.current },
      { allowsHistoryRead: async () => gates.history, allowsRecordRead: async () => gates.record, current: () => gates.current }, port));
    const selection = { patientId: verificationCanaries[2]!, recallRef: "cliniko:recall:71",
      createdFrom: new Date(Date.parse(now) - 3600000).toISOString(), createdThrough: now };
    return { f, native, row, calls, gates, fresh, selection };
  } catch (error) { await f.close(); throw error; }
}

for (const kind of ["cancel", "move", "partial"] as const) for (const passes of [false, true]) for (const archived of [false, true])
test(`actual admitted ${passes ? "pass" : "ordinary"} class ${kind} recovers its ${archived ? "closed archived" : "active"} historical report`, async t => {
  const x = await fixture(kind, passes); t.after(x.f.close);
  if (archived) { x.row.archived_at = x.native.clock!(); x.row.recalled = true; x.f.memoRows[0]!.archived_at = x.native.clock!(); }
  const found = resultValue(await x.fresh().recover(x.selection, new AbortController().signal)); assert.ok(found.kind === "located");
  const original = resultValue(decodeClinikoReview(x.row.notes)), outcome = found.record.memo.outcome;
  assert.ok(original.request.operation.kind === "classCancel" || original.request.operation.kind === "classMove");
  assert.equal(found.record.memo.sourceActionRef, original.request.operation.kind === "classMove" ? original.request.operation.attendanceActionId : original.marker);
  assert.equal(outcome.kind, kind === "cancel" ? "classCancellationObserved" : "classMovementReported");
  if (outcome.kind === "classMovementReported") {
    assert.equal(outcome.completion, kind === "partial" ? "needsReview" : "moved");
    assert.deepEqual(outcome.progress, { original: kind === "partial" ? "notSent" : "inspectedCancelled", replacement: "inspectedActive",
      caseAssociation: passes ? kind === "partial" ? "unlinked" : "inspectedLinked" : "notApplicable" });
    assert.equal(outcome.verification.basis, "nativeWorkflowReportBestEffort");
  }
  assert.equal(x.f.writes.length, kind === "cancel" || kind === "partial" ? 1 : passes ? 3 : 2);
  assert.equal(x.f.memoPosts.length, 1); assert.equal(x.f.consumed.size, 1);
});

for (const kind of ["cancel", "move", "partial"] as const)
test(`unretained class ${kind} memo does not authorize replay or complete a partial move`, async t => {
  const x = await fixture(kind, true, "lostUnstored"); t.after(x.f.close); const writes = x.f.writes.length;
  assert.equal(resultValue(await x.fresh().recover(x.selection, new AbortController().signal)).kind, "notLocated");
  assert.equal(x.f.writes.length, writes); assert.equal(x.f.memoPosts.length, 1); assert.equal(x.f.consumed.size, 1);
});

for (const kind of ["cancel", "move", "partial"] as const) for (const denied of ["source", "history", "record", "current"] as const)
test(`actual class ${kind} requires independent ${denied} recovery permission`, async t => {
  const x = await fixture(kind); t.after(x.f.close); x.gates[denied] = false;
  assert.equal((await x.fresh().recover(x.selection, new AbortController().signal)).ok, false);
  if (denied === "source" || denied === "current") assert.deepEqual(x.calls, []);
});

for (const kind of ["cancel", "move", "partial"] as const) for (const field of ["attendee", "interval", "destination"] as const) {
  if (kind === "cancel" && field === "destination") continue;
  test(`edited class ${kind} original ${field} cannot promote a different memo`, async t => {
    const x = await fixture(kind); t.after(x.f.close); const original = resultValue(decodeClinikoReview(x.row.notes)), operation = original.request.operation;
    assert.ok(operation.kind === "classCancel" || operation.kind === "classMove");
    const updated = field === "attendee" ? { ...operation, attendeeId: "102" } : field === "interval" ? { ...operation, startsAt: "2026-10-08T04:05:00.000Z" } :
      operation.kind === "classMove" ? { ...operation, newSessionId: "95" } : operation;
    x.row.notes = resultValue(encodeClinikoReview(original.marker, { ...original.request, operation: updated }));
    assert.equal((await x.fresh().recover(x.selection, new AbortController().signal)).ok, false);
    assert.equal(x.f.memoPosts.length, 1);
  });
}
