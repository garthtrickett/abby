import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { encodeOutboundStaffReviewRequest, outboundStaffReviewActionRef } from "../../src/cliniko/outbound-staff-review-request.ts";
import { outboundStaffReviewFixture } from "../support/outbound-staff-review.ts";
import { value } from "../support/outbound-records.ts";

test("cold native history finds a stored pending review without any saved note identifier or second write", async () => {
  const f = outboundStaffReviewFixture(); f.state.response = (row, method) => {
    if (method === "POST") throw Error("synthetic ACK lost"); return Response.json(row);
  };
  assert.deepEqual(value(await f.retain()), { kind: "uncertain" });
  const found = value(await f.find()); assert.deepEqual(found.record?.record, f.request); assert.equal(found.selected, 1); assert.equal(found.scanned, 1);
  assert.equal(f.state.claims, 4); assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  assert.ok(f.historyQueries.every(q => q.includeArchived && q.includeClosed && q.original.recallRef === f.possible.recallRef));
  assert.equal((await f.retain()).ok, false);
});

test("missing native history never resets the original review purpose or proves no-stop", async () => {
  const f = outboundStaffReviewFixture(); value(await f.retain()); f.rows.clear();
  const absent = value(await f.find()); assert.equal(absent.record, undefined); assert.equal(absent.selected, 0);
  assert.equal((await f.retain()).ok, false); assert.deepEqual([...f.burned], [f.request.actionRef]);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});

test("native staff closure and archive preserve exact pending contents without permitting another call", async () => {
  const f = outboundStaffReviewFixture(); value(await f.retain());
  const row = f.rows.get("400")!; row.recalled = true; row.recalled_at = f.state.now; row.archived_at = f.state.now;
  const found = value(await f.find()); assert.equal(found.record?.archivedAt, f.state.now); assert.equal(found.record?.record.state, "needsClinicReview");
  assert.equal(Object.hasOwn(found.record!.record, "permission"), false); assert.equal((await f.retain()).ok, false);
});

test("broad clinic history permission is separate from protected staff review content permission", async () => {
  const f = outboundStaffReviewFixture(); value(await f.retain()); f.state.historyAllowed = false;
  const calls = f.calls.length; assert.equal((await f.find()).ok, false); assert.equal(f.calls.length, calls);
  f.state.historyAllowed = true; f.state.decoded = false; assert.equal((await f.find()).ok, false);
});

test("source or history grants withdrawn after a later scan cannot return previously readable staff work", async () => {
  const f = outboundStaffReviewFixture(); value(await f.retain()); let scans = 0;
  f.state.page = rows => { scans++; if (scans === 2) f.state.live = false; return Response.json({ recalls: rows, total_entries: rows.length }); };
  assert.equal((await f.find()).ok, false); assert.equal(scans, 2); assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});

test("a selected record edited between broad history and its exact protected read remains unresolved", async () => {
  const f = outboundStaffReviewFixture(); value(await f.retain());
  f.state.page = rows => {
    const response = Response.json({ recalls: rows, total_entries: rows.length });
    f.rows.get("400")!.notes = value(encodeOutboundStaffReviewRequest({ ...f.request, notification: { ...f.request.notification, digest: "b".repeat(64) } }));
    return response;
  };
  const found = await f.find(); assert.equal(found.ok, false); if (!found.ok) assert.equal(found.error.kind, "mismatched");
});

for (const mode of ["duplicate", "malformed", "sourceCollision", "oversized"] as const) test(`native ${mode} staff history cannot pick a convenient task or authorize replay`, async () => {
  const f = outboundStaffReviewFixture(); value(await f.retain()); const row = f.rows.get("400")!;
  if (mode === "duplicate") f.rows.set("401", { ...row, id: "401", links: { self: "https://api.au5.cliniko.com/v1/recalls/401" } });
  if (mode === "malformed") row.notes = "unrecognized private review";
  if (mode === "sourceCollision") {
    const originalAction = randomUUID();
    row.notes = value(encodeOutboundStaffReviewRequest({ ...f.request, actionRef: outboundStaffReviewActionRef(originalAction)!,
      attempt: { ...f.request.attempt, actionRef: originalAction } }));
  }
  if (mode === "oversized") f.state.page = rows => Response.json({ recalls: rows, total_entries: 501 });
  assert.equal((await f.find()).ok, false); assert.equal((await f.retain()).ok, false);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});

test("unrelated native families are scanned within the clinic grant and never treated as contact decisions", async () => {
  const f = outboundStaffReviewFixture(); value(await f.retain());
  const row = f.rows.get("400")!;
  f.rows.set("401", { ...row, id: "401", links: { self: "https://api.au5.cliniko.com/v1/recalls/401" },
    recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/99" } }, notes: "separate clinic-owned finance record" });
  const found = value(await f.find()); assert.equal(found.scanned, 2); assert.equal(found.selected, 1); assert.deepEqual(found.record?.record, f.request);
});

test("foreign original identity or an aborted caller cannot start clinic history transport", async () => {
  const f = outboundStaffReviewFixture();
  assert.equal((await f.history().findForAttempt({ ...f.possible, attempt: { ...f.possible.attempt, businessId: "99" } }, new AbortController().signal)).ok, false);
  const controller = new AbortController(); controller.abort(); assert.equal((await f.find(controller.signal)).ok, false); assert.equal(f.calls.length, 0);
});
