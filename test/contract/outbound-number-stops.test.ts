import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { outboundNumberStopsFixture } from "../support/outbound-number-stops.ts";
import { value } from "../support/outbound-records.ts";
import { ClinikoOutboundNumberStops } from "../../src/standalone/cliniko-outbound-number-stops.ts";

test("complete explicitly approved native sources give bounded observation without contact permission or cross-patient disclosure", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); const found = value(await f.read());
  assert.equal(found.disposition, "noRecordedStopObserved"); assert.equal(f.state.claims, 4);
  assert.deepEqual(f.queries[0]!.requestSource.scope, f.first.request.scope); assert.equal(f.queries[0]!.transportCredentialFingerprint, f.first.request.credentialFingerprint);
  assert.deepEqual(Object.keys(found).sort(), ["accountBinding", "disposition", "kind", "observedAt", "requestDigest"]);
  assert.equal(JSON.stringify(found).includes(f.first.request.recipient.number), false);
  assert.ok(f.queries.some(q => q.operation === "readContactNumberReview" && q.review?.patientId === "22"));
});
test("another patient at another clinic location blocks this same number", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); f.stopOther();
  assert.equal(value(await f.read()).disposition, "blocked"); assert.equal(f.calls.some(url => url.pathname.includes("patients")), false);
});
for (const flag of ["archived", "closed", "expired"] as const)
  test(`a historical stop is not erased by ${flag}`, async t => {
    const f = await outboundNumberStopsFixture(); t.after(f.close); const stop = f.stopOther(), row = f.state.rows.find(r => r.id === "202")!;
    if (flag === "archived") row.archived_at = f.first.state.now;
    if (flag === "closed") { row.recalled = true; row.recalled_at = f.first.state.now; }
    if (flag === "expired") { row.notes = f.note({ ...stop, effectiveUntil: "2026-11-02T00:00:01.000Z" }); f.first.state.now = "2026-11-02T00:00:02.000Z"; }
    assert.equal(value(await f.read()).disposition, "blocked");
  });
test("an explicitly declared retired credential source remains readable through the current physical account", async t => {
  const f = await outboundNumberStopsFixture({ otherApiKey: "synthetic-retired-credential-au5" }); t.after(f.close); f.stopOther();
  assert.equal(value(await f.read()).disposition, "blocked");
  assert.ok(f.queries.some(q => q.operation === "readContactNumberReview" && q.source.credentialFingerprint === f.second.request.credentialFingerprint));
  assert.ok(f.queries.every(q => q.transportCredentialFingerprint === f.first.request.credentialFingerprint));
});
test("current native reconsent needs a separately current exact-number stop-resolution grant", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); const stop = f.stopOther(); f.clearOther(stop);
  f.state.allow = q => q.operation !== "approveNumberStopResolution";
  assert.equal((await f.read()).ok, false);
  f.state.allow = () => true; assert.equal(value(await f.read()).disposition, "noRecordedStopObserved");
  assert.ok(f.queries.some(q => q.operation === "approveNumberStopResolution" && q.stop.review.actionRef === stop.actionRef && q.head.review.patientId === "22"));
});
for (const operation of ["readAccountContactHistory", "readContactNumberReview", "approveContactNumberHead", "approveNumberReconsent"] as const)
  test(`independent ${operation} denial cannot become clear evidence`, async t => {
    const f = await outboundNumberStopsFixture(); t.after(f.close); f.clearOther(f.stopOther());
    f.state.allow = q => q.operation !== operation;
    assert.equal((await f.read()).ok, false); if (operation === "readAccountContactHistory") assert.equal(f.calls.length, 0);
  });
test("approval of a prior patient's number cannot clear a different patient's independent stop", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); f.clearOther(f.stopOther());
  const ownStop = f.first.next(f.first.first, { consent: "unknown", doNotCall: "blocked", reviewedAt: f.first.state.now, effectiveFrom: f.first.state.now });
  f.append(ownStop, "102"); assert.equal(value(await f.read()).disposition, "blocked");
});
test("reconsent for a new phone cannot clear the old shared number", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); f.clearOther(f.stopOther(), { recipient: { kind: "voice", number: "+12025550999" } });
  assert.equal(value(await f.read()).disposition, "blocked");
});
test("a number clearance that expires during its last grant wait is no longer clear", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); f.clearOther(f.stopOther(), { effectiveUntil: "2026-11-02T00:00:01.000Z" });
  f.state.allow = q => { if (q.operation === "approveNumberStopResolution") f.first.state.now = "2026-11-02T00:00:02.000Z"; return true; };
  assert.equal(value(await f.read()).disposition, "blocked");
});
test("a late new stop during clearance approval is found by the repeated complete native scan", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); const clear = f.clearOther(f.stopOther()); let changed = false;
  f.state.allow = q => { if (q.operation === "approveNumberStopResolution" && !changed) { changed = true;
    f.append(f.second.next(clear, { consent: "unknown", doNotCall: "blocked", reviewedAt: f.first.state.now, effectiveFrom: f.first.state.now }), "204"); } return true; };
  assert.equal((await f.read()).ok, false);
});
test("withdrawing complete source coverage during a private record grant refuses", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); let changed = false;
  f.state.allow = async q => { if (q.operation === "readContactNumberReview" && q.review && !changed) { changed = true; await f.replace({ enabled: false }); } return true; };
  assert.equal((await f.read()).ok, false);
});
test("unrelated native recall bodies still require the broad account grant", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); const unrelated = { ...f.first.row(f.first.first, "301"), notes: "discard-private-unrelated-note",
    recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/61" } } }; f.state.rows.push(unrelated);
  assert.equal(value(await f.read()).disposition, "noRecordedStopObserved");
  assert.equal(f.queries.some(q => JSON.stringify(q).includes("discard-private-unrelated-note")), false);
});
test("an unknown selected source, malformed history or duplicate action cannot disappear as unrelated", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); const row = f.state.rows[1]!;
  row.notes = f.note({ ...f.secondary, policy: { version: "unknown-policy", digest: "a".repeat(64) } });
  assert.equal((await f.read()).ok, false);
  row.notes = f.note({ ...f.secondary, actionRef: f.first.first.actionRef }); assert.equal((await f.read()).ok, false);
  row.notes = "invalid selected contact history"; assert.equal((await f.read()).ok, false);
});
test("changed exact native records refuse before returning a source observation", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close);
  f.state.get = row => Response.json({ ...row, updated_at: "2026-11-02T00:00:00.000Z" }); assert.equal((await f.read()).ok, false);
});
test("quota, native429 and backwards clocks cannot give clear evidence", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close);
  for (let n = 0; n < 180; n++) if (await f.budget.claim() !== null) break;
  assert.equal((await f.read()).ok, false); assert.equal(f.calls.length, 0);
  const g = await outboundNumberStopsFixture(); t.after(g.close); g.state.page = () => new Response(null, { status: 429 });
  assert.equal((await g.read()).ok, false); assert.ok(await g.budget.claim());
  const h = await outboundNumberStopsFixture(); t.after(h.close); h.first.state.now = "2026-11-01T00:00:00.000Z";
  assert.equal((await h.read()).ok, false);
});
test("a foreign request and absent local contact-source role refuse", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close);
  assert.equal((await f.reader.readForRequest({ ...f.first.request, patientId: "22", scope: f.second.request.scope }, new AbortController().signal)).ok, false);
  const cold = value(ClinikoOutboundNumberStops.create({ ...f.config, source: { ...f.config.source, contactReviewRecallTypeId: "99" } },
    { allows: async () => true, current: () => true }, async () => { throw Error("No native request allowed"); }));
  assert.equal((await cold.readForRequest(f.first.request, new AbortController().signal)).ok, false); assert.equal(f.calls.length, 0);
});
test("pre-aborted read does no native work and captured grants cannot be replaced", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); const controller = new AbortController(); controller.abort();
  assert.equal((await f.read(controller.signal)).ok, false); assert.equal(f.calls.length, 0);
  f.state.live = false; Object.assign(f.authority, { allows: async () => true, current: () => true }); assert.equal((await f.read()).ok, false);
});
for (const [total, selected] of [[500, 50], [501, 50], [100, 51]] as const)
  test(`account aggregate bounds retain completeness: ${total} native rows and ${selected} selected`, { timeout: 15000 }, async t => {
    const f = await outboundNumberStopsFixture(); t.after(f.close);
    f.state.rows = Array.from({ length: total }, (_, i) => {
      const review = { ...f.first.first, patientId: String(1000 + i), actionRef: randomUUID(), approvalRef: randomUUID() };
      return { ...f.first.row(review, String(i + 1)), ...(i < selected ? {} : { notes: "unrelated note", recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/61" } } }) };
    });
    const found = await f.read(); if (total === 500) { assert.equal(value(found).disposition, "noRecordedStopObserved"); assert.equal(f.state.claims, 60); }
    else assert.equal(found.ok, false);
  });

test("independent patients may reference the same human approval without inheriting each other's number resolution", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close);
  Object.assign(f.secondary, { approvalRef: f.first.first.approvalRef }); f.state.rows[1]!.notes = f.note(f.secondary);
  assert.equal(value(await f.read()).disposition, "noRecordedStopObserved");
  const stop = f.stopOther(); assert.equal(value(await f.read()).disposition, "blocked");
  f.clearOther(stop); f.state.allow = q => q.operation !== "approveNumberStopResolution";
  assert.equal((await f.read()).ok, false);
});
test("approval aliasing within one patient's lineage remains invalid", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close);
  f.append(f.first.next(f.first.first, { approvalRef: f.first.first.approvalRef }), "102"); assert.equal((await f.read()).ok, false);
});
test("a replaced account-current method cannot reactivate withdrawn native source coverage", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); await f.replace({ enabled: false });
  Object.assign(f.owner, { current: async () => ({ ok: true, value: f.approval }) });
  assert.equal((await f.read()).ok, false);
});

test("the existing patient-only pager refuses a missing patient instead of widening to an account read", async () => {
  const { readPatientRecallHistory } = await import("../../src/cliniko/internal/patient-recall-history.ts"); let calls = 0;
  await assert.rejects(readPatientRecallHistory({ base: "https://api.au5.cliniko.com/v1", patientId: undefined as unknown as string, typeId: "91" },
    async () => { calls++; return {}; }, () => "2026-11-02T00:00:00.000Z")); assert.equal(calls, 0);
});
test("the account pager refuses an injected patient filter and snapshots selected source roles before waits", async t => {
  const { readAccountRecallHistory } = await import("../../src/cliniko/internal/patient-recall-history.ts"); const f = await outboundNumberStopsFixture(); t.after(f.close); let calls = 0;
  await assert.rejects(readAccountRecallHistory({ base: "https://api.au5.cliniko.com/v1", typeIds: ["91"], patientId: "21" } as unknown as Parameters<typeof readAccountRecallHistory>[0],
    async () => { calls++; return {}; }, () => f.first.state.now)); assert.equal(calls, 0);
  const typeIds = ["91"], found = await readAccountRecallHistory({ base: "https://api.au5.cliniko.com/v1", typeIds },
    async () => { typeIds.splice(0); return { recalls: [f.state.rows[0]], total_entries: 1 }; }, () => f.first.state.now);
  assert.equal(found.rows.length, 1);
});

for (const stage of ["headroom", "claim"] as const)
  test(`unavailable physical ${stage} is not relabelled as a quota window`, async t => {
    const budget = { checkHeadroom: () => stage === "headroom" ? { kind: "unavailable" as const } : null,
      claim: () => ({ kind: "unavailable" as const }), observe429: () => ({ kind: "rateLimited" as const }) };
    const f = await outboundNumberStopsFixture({ budget }); t.after(f.close);
    assert.deepEqual(await f.read(), { ok: false, error: { kind: "unavailable" } }); assert.equal(f.calls.length, 0);
  });

test("an unlisted historical native contact type cannot vanish as an unrelated recall", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close);
  f.state.rows.push(f.first.row({ ...f.first.first, actionRef: randomUUID(), approvalRef: randomUUID(), patientId: "33",
    contactRecallTypeId: "92", consent: "unknown", doNotCall: "blocked" }, "301"));
  assert.equal((await f.read()).ok, false);
});

test("unknown future contact-review formats in unlisted types cannot give absence evidence", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close);
  const review = { ...f.first.first, actionRef: randomUUID(), approvalRef: randomUUID(), patientId: "33", contactRecallTypeId: "92" };
  f.state.rows.push({ ...f.first.row(review, "301"), notes: f.note(review).replace("Abby voice contact review v1", "Abby voice contact review v2") });
  assert.equal((await f.read()).ok, false);
});
test("an omitted historical role added during clearance is detected before absence is returned", async t => {
  const f = await outboundNumberStopsFixture(); t.after(f.close); f.clearOther(f.stopOther()); let changed = false;
  f.state.allow = q => { if (q.operation === "approveNumberStopResolution" && !changed) { changed = true;
    f.state.rows.push(f.first.row({ ...f.first.first, actionRef: randomUUID(), approvalRef: randomUUID(), patientId: "33",
      contactRecallTypeId: "92", consent: "unknown", doNotCall: "blocked" }, "301")); } return true; };
  assert.equal((await f.read()).ok, false);
});
