import assert from "node:assert/strict";
import test from "node:test";
import { TwilioAbbyOutboundFinality } from "../../src/standalone/twilio-outbound-finality.ts";
import { TwilioOutboundReportAuthentication, encodeTwilioOutboundReport } from "../../src/cliniko/twilio-outbound-report.ts";
import { encodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import type { TwilioRuntimeHistoryAuthority } from "../../src/cliniko/twilio-outbound-runtime-history.ts";
import { callClosureFixture } from "../support/twilio-outbound-call-closure.ts";
import { twilioRuntimeHistoryFixture } from "../support/twilio-outbound-runtime-history.ts";
import { value } from "../support/outbound-records.ts";
async function fixture() {
  const f = await twilioRuntimeHistoryFixture(), provider = callClosureFixture(), selected = provider.runtime.binding();
  const attempt = { ...f.context.original.attempt, provider: { ref: selected.ref, bindingDigest: selected.bindingDigest } };
  f.originalRow.notes = value(encodeOutboundLaunchAttempt(attempt));
  const authentication = new TwilioOutboundReportAuthentication(Buffer.alloc(32, 17), attempt.provider);
  const { authentication: _old, ...unsigned } = f.report;
  const report = value(authentication.sign({ ...unsigned, terminal: null, original: { ...unsigned.original, digest: outboundLaunchAttemptDigest(attempt)! } }));
  const row = f.native.rows.get("30")!; row.notes = value(encodeTwilioOutboundReport(report));
  const queries: Parameters<TwilioRuntimeHistoryAuthority["current"]>[0][] = [];
  const state = { nativeLive: true, allowed: true };
  const allow = async (q: Parameters<TwilioRuntimeHistoryAuthority["current"]>[0]) => { queries.push(q); return state.allowed; };
  const history: TwilioRuntimeHistoryAuthority = { allowsHistoryRead: allow, allowsReportRead: allow, allowsAttemptRead: allow, current: () => state.nativeLive };
  const native: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname === "/v1/recalls") {
      const rows = [...f.native.rows.values()].sort((a, b) => Number(a.id) - Number(b.id));
      return Response.json({ recalls: rows, total_entries: rows.length });
    }
    return f.native.port(input, init);
  };
  const make = () => value(TwilioAbbyOutboundFinality.create({ reports: f.config, attempts: f.attempts }, { runtime: provider.runtime, authentication, history, closure: provider.authority, native }));
  return { ...f, provider, attempt, authentication, report, row, state, queries, make };
}

test("preterminal immutable positive report composes stable final STOP without rewriting it", async () => {
  const f = await fixture(), adapter = f.make(), before = f.row.notes;
  const contact = await adapter.inspectContact(f.identity, new AbortController().signal);
  assert.equal(contact.kind, "complete"); if (contact.kind !== "complete") assert.fail();
  assert.equal(contact.contact, "stopRequested"); assert.equal(contact.attemptDigest, f.report.original.digest);
  assert.equal(contact.reportedAt, f.report.reportedAt); assert.equal(f.row.notes, before);
  assert.deepEqual(adapter.binding(), f.provider.runtime.binding());
  assert.deepEqual(Object.keys(adapter.contactProvider().binding()).sort(), ["bindingDigest", "ref"]);
  const cold = f.make(), second = await cold.inspectContact(f.identity, new AbortController().signal);
  assert.deepEqual(second, contact);
  const terminal = await cold.inspectTerminal(f.identity, new AbortController().signal); assert.equal(terminal.kind, "terminal");
  assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});

test("MAC integrity and root completion alone cannot bypass independent complete-source approval", async () => {
  const f = await fixture(); f.provider.state.grant = q => q.operation !== "approveExclusiveSingleRootProfile";
  assert.deepEqual(await f.make().inspectContact(f.identity, new AbortController().signal), { kind: "unknown" });
  assert.equal(f.provider.state.count, 0);
});

test("native permission withdrawal during provider read keeps both observations unknown", async () => {
  const f = await fixture(); f.provider.state.response = relative => { f.state.nativeLive = false; return Response.json(relative === f.provider.rootPath ? f.provider.raw : f.provider.children); };
  assert.deepEqual(await f.make().inspectTerminal(f.identity, new AbortController().signal), { kind: "unknown" });
});

test("origin edits during provider wait are detected by cold native reread", async () => {
  const f = await fixture(); f.provider.state.response = relative => {
    f.originalRow.notes = value(encodeOutboundLaunchAttempt({ ...f.attempt, dispatchNotAfter: "2026-11-01T10:00:11.000Z" }));
    return Response.json(relative === f.provider.rootPath ? f.provider.raw : f.provider.children);
  };
  assert.deepEqual(await f.make().inspectContact(f.identity, new AbortController().signal), { kind: "unknown" });
});

test("missing producer and authenticated completeNoStop remain unqualified for this positive-only adapter", async () => {
  for (const mode of ["missing", "noStop"] as const) {
    const f = await fixture();
    if (mode === "missing") f.native.rows.delete("30");
    else { const { authentication: _, ...unsigned } = f.report;
      f.row.notes = value(encodeTwilioOutboundReport(value(f.authentication.sign({ ...unsigned, terminal: { endedAt: "2026-11-01T10:02:00.000Z", observedAt: "2026-11-01T10:02:01.000Z" }, contact: { kind: "completeNoStop" } })))); }
    assert.deepEqual(await f.make().inspectContact(f.identity, new AbortController().signal), { kind: "unknown" }); assert.equal(f.provider.state.count, 0);
  }
});
