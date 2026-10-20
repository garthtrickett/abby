import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoTwilioOutboundRuntimeHistory } from "../../src/cliniko/twilio-outbound-runtime-history.ts";
import type { TwilioRuntimeHistoryQuery } from "../../src/cliniko/twilio-outbound-runtime-history.ts";
import { TwilioOutboundReportAuthentication, encodeTwilioOutboundReport } from "../../src/cliniko/twilio-outbound-report.ts";
import { encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { value } from "../support/outbound-records.ts";
import { twilioRuntimeHistoryFixture as fixture } from "../support/twilio-outbound-runtime-history.ts";
const signal = () => new AbortController().signal;


test("cold runtime identity discovers MAC evidence without session or reserved report IDs", async () => {
  const f = await fixture(), found = value(await f.find());
  assert.deepEqual(found.evidence?.report.record, f.report); assert.deepEqual(found.evidence?.original.attempt, f.context.original.attempt);
  assert.equal(found.selected, 1); assert.equal(found.scanned, 2); assert.equal(f.historyState.pages, 2);
  const collection = f.historyState.queries.find(q => q.operation === "readAccountProviderReportHistory") as TwilioRuntimeHistoryQuery;
  assert.deepEqual(collection.identity, f.identity); assert.equal(collection.reports.authenticationBinding, f.auth.authenticationBinding());
  assert.equal("sessionActionRef" in collection, false); assert.equal("reportActionRef" in collection, false);
  assert.ok(f.historyState.queries.some(q => q.operation === "readPossibleLaunch" && q.attempt));
  assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});

test("native absence supplies no clearance or report and consumes no permanent action", async () => {
  const f = await fixture(); f.native.rows.delete("30");
  assert.deepEqual(value(await f.find()), { kind: "nativeRuntimeHistory", selected: 0, scanned: 1 }); assert.equal(f.burned.size, 1);
});

for (const denial of ["collection", "report", "decodedReport", "attempt", "decodedAttempt", "current"] as const)
test(`cold runtime lookup requires independent ${denial} permission`, async () => {
  const f = await fixture();
  f.historyState.grant = q => denial === "collection" ? q.operation !== "readAccountProviderReportHistory" : denial === "report" ? q.operation !== "readProviderReport" :
    denial === "decodedReport" ? !(q.operation === "readProviderReport" && q.report) : denial === "attempt" ? q.operation !== "readPossibleLaunch" :
    denial === "decodedAttempt" ? !(q.operation === "readPossibleLaunch" && q.attempt) : true;
  if (denial === "current") f.historyState.live = false;
  assert.equal((await f.find()).ok, false);
  if (denial === "collection" || denial === "current") assert.equal(f.historyState.pages, 0);
});

for (const conflict of ["mac", "originDigest", "duplicate", "changedScan", "changedOrigin", "foreignAccount", "halfPair", "futureReport", "missingOrigin"] as const)
test(`runtime recovery never treats ${conflict} as authenticated original correlation`, async () => {
  const f = await fixture(), row = f.native.rows.get("30")!;
  if (conflict === "mac") row.notes = value(encodeTwilioOutboundReport({ ...f.report, number: "+12025550124" }));
  if (conflict === "originDigest") f.originalRow.notes = value(encodeOutboundLaunchAttempt({ ...f.context.original.attempt, dispatchNotAfter: "2026-11-01T10:00:11.000Z" }));
  if (conflict === "duplicate") f.native.rows.set("31", { ...row, id: "31", links: { self: "https://api.au5.cliniko.com/v1/recalls/31" } });
  if (conflict === "changedScan") f.historyState.page = rows => Response.json({ recalls: f.historyState.pages > 1 ? rows.filter(r => r.id !== "30") : rows, total_entries: f.historyState.pages > 1 ? rows.length - 1 : rows.length });
  if (conflict === "changedOrigin") f.historyState.page = rows => {
    if (f.historyState.pages > 1) f.originalRow.notes = value(encodeOutboundLaunchAttempt({ ...f.context.original.attempt, dispatchNotAfter: "2026-11-01T10:00:11.000Z" }));
    return Response.json({ recalls: rows, total_entries: rows.length });
  };
  if (conflict === "foreignAccount") return assert.equal((await f.makeRuntimeHistory().findForRuntime(f.identity, "AC" + "9".repeat(32), signal())).ok, false);
  if (conflict === "halfPair") return assert.equal((await f.makeRuntimeHistory().findForRuntime({ ...f.identity, capacityAllocationRef: randomUUID() }, f.report.accountSid, signal())).ok, false);
  if (conflict === "futureReport") { const { authentication: _, ...unsigned } = f.report; row.notes = value(encodeTwilioOutboundReport(value(f.auth.sign({ ...unsigned, reportedAt: "2026-11-01T10:04:01.000Z", recordedAt: "2026-11-01T10:04:01.000Z" })))); }
  if (conflict === "missingOrigin") f.native.rows.delete(String(f.originalRow.id));
  assert.equal((await f.find()).ok, false);
});

test("closed archived evidence is retained in complete recovery", async () => {
  const f = await fixture(); for (const row of f.native.rows.values()) Object.assign(row, { recalled: true, recalled_at: f.report.recordedAt, archived_at: f.report.recordedAt, updated_at: f.report.recordedAt });
  assert.equal(value(await f.find()).evidence?.report.archivedAt, f.report.recordedAt);
});

test("selected verifier key and config changes cannot resurrect native evidence", async () => {
  const f = await fixture(), wrong = new TwilioOutboundReportAuthentication(Buffer.alloc(32, 99), f.auth.binding());
  assert.equal((await f.makeRuntimeHistory(wrong).findForRuntime(f.identity, f.report.accountSid, signal())).ok, false);
  assert.equal(ClinikoTwilioOutboundRuntimeHistory.create({ reports: f.config, attempts: { ...f.attempts, rateBudget: { ...f.config.rateBudget } } }, f.auth,
    { allowsHistoryRead: async () => true, allowsReportRead: async () => true, allowsAttemptRead: async () => true, current: () => true }).ok, false);
});

test("decoded attempt permission withdrawal invalidates the whole read", async () => {
  const f = await fixture(); f.historyState.grant = q => { if (q.operation === "readPossibleLaunch" && q.attempt) f.historyState.live = false; return true; };
  assert.equal((await f.find()).ok, false);
});

test("broad history bounds, pagination and owned-response failures remain conservative", async () => {
  for (const response of [Response.json({ recalls: [], total_entries: 501 }), Response.json({ recalls: [], total_entries: 2 }), new Response("bad", { status: 200 }), new Response(null, { status: 429 }), new Response(null, { status: 403 })]) {
    const f = await fixture(); f.historyState.page = () => response; assert.equal((await f.find()).ok, false);
  }
});

test("invalid identity and aborted caller cannot dispatch broad history", async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  assert.equal((await f.makeRuntimeHistory().findForRuntime(f.identity, f.report.accountSid, controller.signal)).ok, false);
  assert.equal((await f.makeRuntimeHistory().findForRuntime({ ...f.identity, extra: true } as typeof f.identity, f.report.accountSid, signal())).ok, false);
  assert.equal(f.historyState.pages, 0);
});


test("malformed or backwards clock cannot publish even absent runtime evidence", async () => {
  for (const at of [undefined, null, "invalid", "2026-02-30T00:00:00.000Z"]) {
    const f = await fixture(); f.native.rows.clear();
    const h = value(ClinikoTwilioOutboundRuntimeHistory.create({ reports: { ...f.config, clock: () => at as string }, attempts: f.attempts }, f.auth,
      { allowsHistoryRead: async () => true, allowsReportRead: async () => true, allowsAttemptRead: async () => true, current: () => true },
      async () => assert.fail("bad clock must not dispatch")));
    assert.equal((await h.findForRuntime(f.identity, f.report.accountSid, signal())).ok, false);
  }
  const f = await fixture(); f.historyState.grant = () => { f.native.setNow("2026-11-01T10:03:59.000Z"); return true; };
  assert.equal((await f.find()).ok, false); assert.equal(f.historyState.pages, 0);
});
