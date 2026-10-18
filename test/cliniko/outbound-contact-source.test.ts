import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { outboundContactSourceFixture } from "../support/outbound-contact-source.ts";
import { value } from "../support/outbound-records.ts";
const signal = () => new AbortController().signal;
test("actual native contact source needs no email, observes exact current phone, full history and independent head grant", async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); const found = value(await f.read());
  assert.equal(found.disposition, "eligibleEvidence"); assert.equal(found.head?.review.actionRef, f.first.actionRef);
  assert.equal(f.calls.filter(u => u.pathname === "/v1/recalls").length, 2); assert.equal(f.calls.filter(u => u.pathname.startsWith("/v1/patients/")).length, 2);
  assert.equal(f.state.claims, f.calls.length); assert.ok(f.queries.some(q => q.operation === "approveContactHead"));
  assert.ok(f.queries.some(q => q.operation === "readContactReview" && q.reviewDigest)); assert.ok(Object.isFrozen(found.head?.review));
});
for (const operation of ["readPatientContact", "readContactHistory", "readContactReview", "approveContactHead"] as const)
  test(`independent ${operation} denial cannot disclose a positive private result`, async t => {
    const f = await outboundContactSourceFixture(); t.after(f.close); f.controls.allow = q => q.operation !== operation;
    assert.deepEqual(await f.read(), { ok: false, error: { kind: "forbidden" } });
  });
test("archived closed DNC remains blocking, and old consent cannot be chosen by native ID", async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); const stop = f.next(f.first, { doNotCall: "blocked" });
  f.controls.rows = [f.row(stop, "101"), f.row(f.first, "102")];
  Object.assign(f.controls.rows[0]!, { recalled: true, recalled_at: "2026-11-01T00:00:00.000Z", archived_at: "2026-11-01T00:00:00.000Z" });
  const found = value(await f.read()); assert.equal(found.disposition, "blocked"); assert.equal(found.head?.review.actionRef, stop.actionRef);
});
test("reconsent requires its independent current approval for the exact predecessor-bound review", async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); const stop = f.next(f.first, { doNotCall: "blocked" });
  const renew = f.next(stop, { doNotCall: "clear", reconsentApprovalRef: randomUUID() }); f.controls.rows = [f.row(f.first), f.row(stop, "102"), f.row(renew, "103")];
  f.controls.allow = q => q.operation !== "approveContactReconsent";
  assert.deepEqual(await f.read(), { ok: false, error: { kind: "forbidden" } });
  f.controls.allow = () => true; const found = value(await f.read()); assert.equal(found.disposition, "eligibleEvidence");
  assert.ok(f.queries.some(q => q.operation === "approveContactReconsent" && q.approvalRef === renew.reconsentApprovalRef && q.review.predecessor?.actionRef === stop.actionRef));
});
for (const change of ["empty", "fax", "differentPhone", "DNC", "unknownConsent", "unknownDNC", "archivedHead", "closedHead", "expired", "differentPurpose"] as const)
  test(`native ${change} is blocked rather than inferring contact authority`, async t => {
    const f = await outboundContactSourceFixture(); t.after(f.close);
    if (change === "empty") f.controls.rows = [];
    if (change === "fax") f.controls.patient.patient_phone_numbers = [{ number: f.request.recipient.number, phone_type: "Fax" }];
    if (change === "differentPhone") f.controls.patient.patient_phone_numbers = [{ number: "+6145550199", phone_type: "Mobile" }];
    if (change === "DNC") f.controls.rows = [f.row({ ...f.first, doNotCall: "blocked" })];
    if (change === "unknownConsent") f.controls.rows = [f.row({ ...f.first, consent: "unknown" })];
    if (change === "unknownDNC") f.controls.rows = [f.row({ ...f.first, doNotCall: "unknown" })];
    if (change === "archivedHead") f.controls.rows[0]!.archived_at = "2026-11-01T00:00:00.000Z";
    if (change === "closedHead") Object.assign(f.controls.rows[0]!, { recalled: true, recalled_at: "2026-11-01T00:00:00.000Z" });
    if (change === "expired") f.controls.rows = [f.row({ ...f.first, effectiveUntil: f.state.now })];
    if (change === "differentPurpose") f.controls.rows = [f.row({ ...f.first, purposes: ["sickDay"] })];
    assert.equal(value(await f.read()).disposition, "blocked");
  });
for (const change of ["fork", "missingRoot", "foreignPatient", "changedPolicy", "partial", "overBound", "changedReread", "newDNC", "changedPhone", "correctionFence", "roleLoss"] as const)
  test(`native ${change} refuses incomplete or changed evidence`, async t => {
    const f = await outboundContactSourceFixture(); t.after(f.close);
    if (change === "fork") f.controls.rows = [f.row(f.first), f.row(f.next(f.first), "102"), f.row(f.next(f.first), "103")];
    if (change === "missingRoot") f.controls.rows = [f.row(f.next(f.first))];
    if (change === "foreignPatient") f.controls.rows = [f.row({ ...f.first, patientId: "22" })];
    if (change === "changedPolicy") f.controls.rows = [f.row({ ...f.first, policy: { ...f.first.policy, version: "other" } })];
    if (change === "partial") f.controls.total = 2;
    if (change === "overBound") f.controls.total = 501;
    if (change === "changedReread") f.controls.get = row => Response.json({ ...row, updated_at: "2026-11-01T01:00:00.000Z" });
    if (change === "newDNC") { let count = 0; f.controls.page = rows => Response.json({ recalls: ++count === 1 ? rows : [...rows, f.row(f.next(f.first, { doNotCall: "blocked" }), "102")], total_entries: count === 1 ? 1 : 2 }); }
    if (change === "changedPhone") { let count = 0; f.controls.phone = () => Response.json(++count === 1 ? f.controls.patient : { ...f.controls.patient, patient_phone_numbers: [{ number: "+6145550199", phone_type: "Mobile" }] }); }
    if (change === "correctionFence") f.state.revisionBlocked = true;
    if (change === "roleLoss") f.controls.allow = q => { if (q.operation === "approveContactHead") f.state.account = undefined; return true; };
    assert.equal((await f.read()).ok, false);
  });
test("blocked grant/headers/body, clock and source lifetime all share the whole operation deadline", { timeout: 5000 }, async t => {
  for (const stage of ["grant", "headers", "body", "clock"] as const) {
    const f = await outboundContactSourceFixture(); t.after(f.close);
    const config = { ...f.config, deadlineMs: 40 };
    if (stage === "grant") f.controls.allow = () => new Promise(() => {});
    if (stage === "headers") f.controls.phone = () => new Promise(() => {});
    if (stage === "body") f.controls.phone = () => new Response(new ReadableStream({ start() {} }));
    if (stage === "clock") { let reads = 0; config.clock = () => ++reads < 4 ? f.state.now : "2026-11-01T23:59:59.999Z"; }
    const { ClinikoOutboundContactSource } = await import("../../src/cliniko/outbound-contact-source.ts");
    const source = value(ClinikoOutboundContactSource.create(config, f.definition, f.authority, f.port));
    assert.equal((await source.readCurrentForRequest(f.request, signal())).ok, false);
  }
});
test("maximum complete native history uses the original shared budget without private reservation", { timeout: 30000 }, async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); const reviews = [f.first];
  for (let i = 1; i < 50; i++) reviews.push(f.next(reviews.at(-1)!));
  f.controls.rows = Array.from({ length: 500 }, (_, i) => {
    if (i >= 450) return f.row(reviews[i - 450]!, String(100 + i));
    const row = f.row(f.first, String(100 + i)); row.notes = "Unrelated clinic record";
    row.recall_type = { links: { self: "https://api.au5.cliniko.com/v1/recall_types/92" } }; return row;
  });
  const found = value(await f.read()); assert.equal(found.disposition, "eligibleEvidence"); assert.equal(found.head?.review.revision, 50);
  assert.equal(f.state.claims, 62); assert.equal(f.state.claims, f.calls.length); assert.ok(f.state.claims < 180);
});
test("one over the contact-review bound refuses rather than discarding a decision", async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close);
  f.controls.rows = Array.from({ length: 51 }, (_, i) => f.row(f.first, String(100 + i)));
  const found = await f.read(); assert.equal(found.ok, false);
});
test("shared physical rate denial and provider429 preserve reset evidence", async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close);
  f.controls.phone = () => new Response(null, { status: 429, headers: { "X-RateLimit-Reset": "1800000000" } });
  assert.deepEqual(await f.read(), { ok: false, error: { kind: "rateLimited", resetAt: "2026-11-02T00:01:00.000Z" } });
  const { ClinikoOutboundContactSource } = await import("../../src/cliniko/outbound-contact-source.ts");
  const reader = value(ClinikoOutboundContactSource.create({ ...f.config, rateBudget: { ...f.config.rateBudget, claim: () => ({ kind: "rateLimited" as const }) } }, f.definition, f.authority, f.port));
  f.calls.length = 0; assert.deepEqual(await reader.readCurrentForRequest(f.request, signal()), { ok: false, error: { kind: "rateLimited" } }); assert.equal(f.calls.length, 0);
});
