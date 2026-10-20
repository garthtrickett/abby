import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoTwilioOutboundReportHistory } from "../../src/cliniko/twilio-outbound-report-history.ts";
import type { TwilioOutboundReportHistoryQuery } from "../../src/cliniko/twilio-outbound-report-history.ts";
import type { TwilioOutboundReportQuery } from "../../src/cliniko/twilio-outbound-report-records.ts";
import { encodeTwilioOutboundReport } from "../../src/cliniko/twilio-outbound-report.ts";
import { twilioOutboundReportRecordsFixture } from "../support/twilio-outbound-report-records.ts";
import { value } from "../support/outbound-records.ts";
const signal = () => new AbortController().signal;
async function fixture() {
  const f = await twilioOutboundReportRecordsFixture();
  const state: { allowed: boolean; live: boolean; pages: number;
    page?: (rows: Record<string, unknown>[], page: number) => Response | Promise<Response>;
    grant?: (q: TwilioOutboundReportHistoryQuery | TwilioOutboundReportQuery) => boolean | Promise<boolean> } = { allowed: true, live: true, pages: 0 };
  const queries: (TwilioOutboundReportHistoryQuery | TwilioOutboundReportQuery)[] = [];
  const wire: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname !== "/v1/recalls") return f.native.port(input, init);
    assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Basic ${Buffer.from(`${f.config.apiKey}:`).toString("base64")}`);
    assert.deepEqual(u.searchParams.getAll("q[]"), [`patient_id:=${f.report.patientId}`, "archived_at:*"]);
    const rows = [...f.native.rows.values()].sort((a, b) => Number(a.id) - Number(b.id)); state.pages++;
    const page = Number(u.searchParams.get("page"));
    return state.page ? state.page(rows, page) : Response.json({ recalls: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length });
  };
  const authority = {
    allowsHistoryRead: async (q: TwilioOutboundReportHistoryQuery) => { queries.push(q); return state.grant ? state.grant(q) : state.allowed; },
    allowsRecordRead: async (q: TwilioOutboundReportQuery) => { queries.push(q); return state.grant ? state.grant(q) : state.allowed; },
    current: () => state.live,
  };
  const make = () => value(ClinikoTwilioOutboundReportHistory.create(f.config, f.auth, authority, wire));
  return { ...f, historyState: state, historyQueries: queries, makeHistory: make,
    find: () => make().findForOriginal(f.context, f.report.accountSid, signal()) };
}

test("bounded complete history independently recovers closed archived original-bound evidence", async () => {
  const f = await fixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  const row = f.native.rows.get(retained.recallRef.split(":").at(-1)!)!;
  row.recalled = true; row.recalled_at = f.report.recordedAt; row.archived_at = f.report.recordedAt;
  const found = value(await f.find()); assert.deepEqual(found.record?.record, f.report); assert.equal(found.record?.archivedAt, f.report.recordedAt);
  assert.equal(found.selected, 1); assert.equal(found.scanned, 1); assert.equal(f.historyState.pages, 2);
  assert.ok(f.historyQueries.some(q => q.operation === "readProviderReportHistory" && q.includeClosed && q.includeArchived));
  assert.ok(f.historyQueries.every(q => q.authenticationBinding === f.auth.authenticationBinding()));
  assert.ok(f.historyQueries.some(q => q.operation === "readProviderReport" && q.report));
  assert.equal((await f.retain()).ok, false); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});

test("history absence has no write or action-reset side effect", async () => {
  const f = await fixture();
  assert.deepEqual(value(await f.find()), { kind: "nativeProviderReportHistory", selected: 0, scanned: 0 });
  assert.equal(f.burned.size, 0); assert.equal(f.native.calls.some(c => c.method === "POST"), false);
});

for (const denial of ["history", "record", "decoded", "current"] as const)
test(`separate provider report ${denial} authority remains necessary`, async () => {
  const f = await fixture(); value(await f.retain());
  f.historyState.grant = q => denial === "history" ? q.operation !== "readProviderReportHistory" : denial === "record" ? q.operation !== "readProviderReport" :
    denial === "decoded" ? q.operation !== "readProviderReport" || !q.report : true;
  if (denial === "current") f.historyState.live = false;
  assert.equal((await f.find()).ok, false);
});

for (const conflict of ["duplicate", "origin", "mac", "changedScan", "bounds", "malformed"] as const)
test(`conflicting or incomplete native report history refuses: ${conflict}`, async () => {
  const f = await fixture(); value(await f.retain()); const row = f.native.rows.get("30")!;
  if (conflict === "duplicate") f.native.rows.set("31", { ...row, id: "31", links: { self: "https://api.au5.cliniko.com/v1/recalls/31" } });
  if (conflict === "origin") {
    const { authentication: _tag, ...unsigned } = f.report;
    row.notes = value(encodeTwilioOutboundReport(value(f.auth.sign({ ...unsigned, original: { ...unsigned.original, digest: "e".repeat(64) } }))));
  }
  if (conflict === "mac") row.notes = value(encodeTwilioOutboundReport({ ...f.report, contact: { kind: "completeNoStop" } }));
  if (conflict === "changedScan") f.historyState.page = rows => Response.json({ recalls: f.historyState.pages > 1 ? [] : rows, total_entries: f.historyState.pages > 1 ? 0 : rows.length });
  if (conflict === "bounds") f.historyState.page = () => Response.json({ recalls: [], total_entries: 501 });
  if (conflict === "malformed") row.notes = "unrecognized native provider report";
  assert.equal((await f.find()).ok, false);
});

test("a grant withdrawn during decoded private read cannot leak a selected report", async () => {
  const f = await fixture(); value(await f.retain()); let observed = false;
  f.historyState.grant = q => { if (q.operation === "readProviderReport" && q.report) { observed = true; f.historyState.live = false; } return true; };
  assert.equal((await f.find()).ok, false); assert.ok(observed);
});

test("an altered expected SEND digest, account or reserved report action refuses matching history", async () => {
  const f = await fixture(); value(await f.retain());
  for (const context of [{ ...f.context, attemptDigest: "e".repeat(64) }, { ...f.context, reportActionRef: randomUUID() }])
    assert.equal((await f.makeHistory().findForOriginal(context, f.report.accountSid, signal())).ok, false);
  assert.equal((await f.makeHistory().findForOriginal(f.context, "AC" + "9".repeat(32), signal())).ok, false);
});

test("an explicitly provided malformed clock cannot silently fall back to wall time", async () => {
  const f = await fixture();
  for (const at of [undefined, null, "invalid", "2026-02-30T00:00:00.000Z"]) {
    const history = value(ClinikoTwilioOutboundReportHistory.create({ ...f.config, clock: () => at as string }, f.auth,
      { allowsHistoryRead: async () => true, allowsRecordRead: async () => true, current: () => true }, async () => assert.fail("invalid time must not dispatch")));
    assert.equal((await history.findForOriginal(f.context, f.report.accountSid, signal())).ok, false);
  }
});

test("backwards time across an independent history grant refuses before native dispatch", async () => {
  const f = await fixture(); let at = f.report.recordedAt;
  const history = value(ClinikoTwilioOutboundReportHistory.create({ ...f.config, clock: () => at }, f.auth,
    { allowsHistoryRead: async () => { at = "2026-11-01T10:03:59.000Z"; return true; }, allowsRecordRead: async () => true, current: () => true },
    async () => assert.fail("backwards time must not dispatch")));
  assert.equal((await history.findForOriginal(f.context, f.report.accountSid, signal())).ok, false);
});
