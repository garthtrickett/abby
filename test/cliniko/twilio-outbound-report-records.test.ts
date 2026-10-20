import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoTwilioOutboundReportRecords, twilioOutboundReportRecordBinding } from "../../src/cliniko/twilio-outbound-report-records.ts";
import type { TwilioOutboundReportQuery } from "../../src/cliniko/twilio-outbound-report-records.ts";
import { encodeTwilioOutboundReport, TwilioOutboundReportAuthentication } from "../../src/cliniko/twilio-outbound-report.ts";
import { twilioOutboundReportRecordsFixture as fixture } from "../support/twilio-outbound-report-records.ts";
import { value } from "../support/outbound-records.ts";


test("report family retains one original-bound action and cold authenticated read has independent grants", async () => {
  const f = await fixture(), retained = value(await f.retain()); assert.equal(retained.kind, "accepted");
  if (retained.kind !== "accepted") return;
  assert.deepEqual([...f.burned], [f.context.reportActionRef]);
  assert.equal(f.burned.has(f.context.sessionActionRef), false);
  assert.equal(f.burned.has(f.context.original.attempt.actionRef), false);
  const cold = value(ClinikoTwilioOutboundReportRecords.createReadOnly(f.config, f.auth, f.authority, f.native.port));
  assert.equal("retainReportOnce" in cold, false); assert.equal("inspectTerminal" in cold, false);
  const binding = { recallRef: retained.recallRef, actionRef: f.report.actionRef, patientId: f.report.patientId };
  const read = value(await cold.readReport(binding, new AbortController().signal)); assert.deepEqual(read.record, f.report);
  assert.ok(f.queries.some(q => q.operation === "readProviderReport" && !q.report));
  assert.ok(f.queries.some(q => q.operation === "readProviderReport" && q.report && q.reportDigest));
  assert.equal((await f.retain()).ok, false); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});

test("tampered MAC or mismatched original refuses before budget, claim and native send", async () => {
  for (const mode of ["mac", "original", "account"] as const) {
    const f = await fixture(), report = mode === "mac" ? { ...f.report, number: "+12025550999" } : f.report;
    const context = mode === "original" ? { ...f.context, reportActionRef: randomUUID() } : f.context;
    const result = await f.records.retainReportOnce(report, context, mode === "account" ? "AC" + "9".repeat(32) : f.report.accountSid,
      "2026-11-02", new AbortController().signal);
    assert.equal(result.ok, false); assert.equal(f.native.calls.length, 0); assert.equal(f.burned.size, 0); assert.equal(f.native.claims, 0);
  }
});

for (const mode of ["broad", "producer", "current"] as const) test(`independent native report ${mode} denial prevents retention`, async () => {
  const f = await fixture();
  if (mode === "broad") f.state.allowed = false;
  if (mode === "producer") f.state.producer = false;
  if (mode === "current") f.state.live = false;
  assert.equal((await f.retain()).ok, false); assert.equal(f.native.calls.length, 0); assert.equal(f.burned.size, 0);
});

test("valid signed evidence does not bypass decoded private read permission", async () => {
  const f = await fixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  f.state.decoded = false;
  assert.equal((await f.records.readReport({ recallRef: retained.recallRef, actionRef: f.report.actionRef, patientId: f.report.patientId }, new AbortController().signal)).ok, false);
});

test("edited native notes cannot be promoted to authentic provider truth by ordinary record editing", async () => {
  const f = await fixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  const row = f.native.rows.get(retained.recallRef.split(":").at(-1)!)!;
  row.notes = value(encodeTwilioOutboundReport({ ...f.report, contact: { kind: "completeNoStop" } }));
  assert.equal((await f.records.readReport({ recallRef: retained.recallRef, actionRef: f.report.actionRef, patientId: f.report.patientId }, new AbortController().signal)).ok, false);
});

test("closed archived evidence remains readable without allowing a new report action", async () => {
  const f = await fixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  const row = f.native.rows.get(retained.recallRef.split(":").at(-1)!)!;
  row.recalled = true; row.recalled_at = f.report.recordedAt; row.archived_at = f.report.recordedAt;
  const cold = value(ClinikoTwilioOutboundReportRecords.createReadOnly(f.config, f.auth, f.authority, f.native.port));
  const read = value(await cold.readReport({ recallRef: retained.recallRef, actionRef: f.report.actionRef, patientId: f.report.patientId }, new AbortController().signal));
  assert.equal(read.archivedAt, f.report.recordedAt); assert.deepEqual(read.record, f.report);
  assert.equal((await f.retain()).ok, false); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});

test("the native evidence owner can retain a restrictive stop before terminal truth exists", async () => {
  const f = await fixture(), report = value(f.auth.sign({ ...f.unsigned, terminal: null,
    reportedAt: "2026-11-01T10:01:10.000Z", recordedAt: "2026-11-01T10:01:11.000Z" }));
  const retained = value(await f.records.retainReportOnce(report, f.context, report.accountSid, "2026-11-02", new AbortController().signal));
  assert.equal(retained.kind, "accepted"); if (retained.kind !== "accepted") return;
  const read = value(await f.records.readReport({ recallRef: retained.recallRef, actionRef: report.actionRef, patientId: report.patientId }, new AbortController().signal));
  assert.equal(read.record.terminal, null); assert.equal(read.record.contact.kind, "stopRequested");
  assert.equal("inspectTerminal" in f.records, false); assert.deepEqual([...f.burned], [f.context.reportActionRef]);
});

test("independent grants identify the actual key; changing that key never resets a report action", async () => {
  const f = await fixture(), expected = f.auth.authenticationBinding(), wrong = new TwilioOutboundReportAuthentication(Buffer.alloc(32, 29), f.auth.binding());
  assert.notEqual(wrong.authenticationBinding(), expected);
  assert.equal(twilioOutboundReportRecordBinding(f.config, wrong), f.owner, "one-use identity must not split into verifier-key namespaces");
  const authority = { allows: async (q: TwilioOutboundReportQuery) => q.authenticationBinding === expected,
    current: (q: TwilioOutboundReportQuery) => q.authenticationBinding === expected, producerAdmitted: async (q: TwilioOutboundReportQuery) => q.authenticationBinding === expected };
  const forged = value(wrong.sign(f.unsigned)); assert.equal(wrong.verify(forged), true);
  const unapproved = value(ClinikoTwilioOutboundReportRecords.create(f.config, wrong, authority, f.effects, f.native.port));
  assert.equal((await unapproved.retainReportOnce(forged, f.context, forged.accountSid, "2026-11-02", new AbortController().signal)).ok, false);
  assert.equal(f.burned.size, 0); assert.equal(f.native.calls.length, 0);
  const approved = value(ClinikoTwilioOutboundReportRecords.create(f.config, f.auth, authority, f.effects, f.native.port));
  assert.equal(value(await approved.retainReportOnce(f.report, f.context, f.report.accountSid, "2026-11-02", new AbortController().signal)).kind, "accepted");
  const permissive = value(ClinikoTwilioOutboundReportRecords.create(f.config, wrong,
    { allows: async () => true, current: () => true, producerAdmitted: async () => true }, f.effects, f.native.port));
  assert.equal((await permissive.retainReportOnce(forged, f.context, forged.accountSid, "2026-11-02", new AbortController().signal)).ok, false);
  assert.deepEqual([...f.burned], [f.report.actionRef]); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});
