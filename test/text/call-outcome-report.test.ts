import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { CallOutcomeReport } from "../../src/reference/call-outcome-report.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { now, setup, success } from "./fixture.ts";

test("scoped agent outcome report counts proven actions and staff states without patient content", async () => {
  const app = await setup("outcome-report");
  await app.turn("request", "Private patient wants a booking", { kind: "requestAction", request: app.book() });
  const action = await app.pendingAction();
  await app.confirm(action.key);
  await app.worker.process(app.callId, `${action.key}:write`, now);
  const followUpCall = "outcome-follow-up";
  success(await app.runtime.start(followUpCall, app.policy));
  success(await app.runtime.acceptTurn({ callId: followUpCall, turnId: "staff", text: "Private caller details", quality: "clear", at: now },
    { kind: "handoff", reason: "callerRequested" }, now));
  const followUp = success(await app.runtime.read(followUpCall));
  const task = Object.values(followUp.staffItems)[0];
  assert.ok(task);
  await app.worker.process(followUpCall, `${task.key}:open`, now);
  const failedCall = "outcome-read-failure";
  success(await app.runtime.start(failedCall, app.policy));
  success(await app.runtime.acceptTurn({ callId: failedCall, turnId: "failure", text: "Private request", quality: "clear", at: now },
    { kind: "readFailure", target: "patient", failure: "unavailable" }, now));
  const disconnectedCall = "outcome-disconnected";
  success(await app.runtime.admit(disconnectedCall, app.policy, { key: { accountRef: "report-account", providerCallRef: "report-call" },
    dialedNumber: "+6125550100", acceptedAt: now, deadline: "2026-09-28T10:00:30.000Z" }));
  success(await app.runtime.activate(disconnectedCall, "report-session", "2026-09-28T10:00:01.000Z"));
  success(await app.runtime.endCall(disconnectedCall, "report-session", "2026-09-28T10:00:02.000Z", "callerDisconnected"));

  const report = new CallOutcomeReport(app.ledger);
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(app.ledger, policy, new ReferenceClinicHost([], []));
  const agent = new CommandGateway({ actorRef: "report-agent", role: "agent", scope: app.scope }, policy, reception,
    undefined, undefined, report);
  assert.equal(agent.listPermitted().some(item => item.id === "calls.outcomes.v1"), true);
  const result = await agent.submit({ kind: "calls.outcomes.v1" });
  assert.ok(result.ok && result.value.kind === "callOutcomes");
  assert.deepEqual(result.value.page.totals, { calls: 4, committedActions: 1, callsWithUnresolvedActions: 0,
    callsWithStaffRequests: 2, callsWithHostConfirmedTasks: 1, callsWithStaffNeedsReview: 0, callsWithSystemFailure: 1,
    callsWithCallerDisconnect: 1, callsWithMediaFailure: 0, callsWithLeaseExpiry: 0, callsWithTransferConnected: 0 });
  assert.equal(result.value.page.rows.find(row => row.callId === followUpCall)?.hostConfirmedTasks, 1);
  assert.equal(result.value.page.rows.find(row => row.callId === disconnectedCall)?.terminalReason, "callerDisconnected");
  assert.equal(JSON.stringify(result.value).includes("Private"), false);
  assert.equal(JSON.stringify(result.value).includes(app.patient.patientRef), false);
  const foreign = new CommandGateway({ actorRef: "other-agent", role: "agent", scope: { ...app.scope, tenantId: "other" } },
    policy, reception, undefined, undefined, report);
  const hidden = await foreign.submit({ kind: "calls.outcomes.v1" });
  assert.ok(hidden.ok && hidden.value.kind === "callOutcomes");
  assert.equal(hidden.value.page.totals.calls, 0);
});

test("outcome reporting pages through 101 calls without mixing another location", async () => {
  const scope = { tenantId: "outcome-page-tenant", clinicId: "outcome-page-clinic", locationId: "outcome-page-location" };
  const ledger = new MemoryLedger();
  const runtime = new CallRuntime(ledger, scope);
  for (let index = 0; index < 101; index += 1) {
    success(await runtime.start(`outcome-${String(index).padStart(3, "0")}`, referenceDefaultPolicy(scope)));
  }
  success(await new CallRuntime(ledger, { ...scope, locationId: "other" }).start("foreign-call", referenceDefaultPolicy({ ...scope, locationId: "other" })));
  const report = new CallOutcomeReport(ledger);
  const first = success(await report.list(scope));
  assert.equal(first.rows.length, 100);
  assert.equal(first.totals.calls, 100);
  assert.ok(first.nextAfterCallId);
  const second = success(await report.list(scope, first.nextAfterCallId));
  assert.deepEqual(second.rows.map(row => row.callId), ["outcome-100"]);
  assert.equal(second.nextAfterCallId, undefined);
  const invalid = await report.list(scope, "");
  assert.ok(!invalid.ok);
  if (!invalid.ok) assert.equal(invalid.error.kind, "invalidTransition");
});
