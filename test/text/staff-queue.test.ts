import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { StaffQueue } from "../../src/reference/staff-queue.ts";
import { TextReception } from "../../src/reference/text-reception.ts";

const scope: LocationScope = { tenantId: "queue-tenant", clinicId: "queue-clinic", locationId: "queue-location" };
const now = "2026-09-28T10:00:00.000Z";

test("E2E-221 E2E-263 scoped staff queue paginates redacted follow-up and exposes aggregate health to agents", async () => {
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  for (let index = 0; index < 51; index += 1) {
    const callId = `queue-call-${String(index).padStart(3, "0")}`;
    assert.equal((await reception.startCall(callId, scope)).ok, true);
    assert.equal((await reception.answer(scope, { callId, turnId: `private-turn-${index}`, text: "Private patient details", quality: "clear", at: now },
      ["missing"], "Private proposed answer", now)).ok, true);
    assert.equal((await reception.drain(scope, callId, now)).ok, true);
  }
  const queue = new StaffQueue(ledger, () => "2026-09-30T10:00:00.000Z");
  const agent = new CommandGateway({ actorRef: "queue-agent", role: "agent", scope }, policy, reception, undefined, queue);
  assert.equal(agent.listPermitted().some(item => item.id === "staff.list.v1"), true);
  const first = await agent.submit({ kind: "staff.list.v1" });
  assert.ok(first.ok && first.value.kind === "staffQueue");
  assert.equal(first.value.page.items.length, 50);
  assert.equal(first.value.page.items[0]?.overdue, true);
  assert.equal(first.value.page.items[0]?.status, "open");
  assert.equal(JSON.stringify(first.value).includes("Private"), false);
  const cursor = first.value.page.nextAfterTaskKey;
  assert.ok(cursor);
  const second = await agent.submit({ kind: "staff.list.v1", afterTaskKey: cursor });
  assert.ok(second.ok && second.value.kind === "staffQueue");
  assert.equal(second.value.page.items.length, 1);
  assert.equal(second.value.page.nextAfterTaskKey, undefined);
  const health = await agent.submit({ kind: "staff.health.v1" });
  assert.ok(health.ok && health.value.kind === "staffQueueHealth");
  assert.deepEqual(health.value.health, { observedAt: "2026-09-30T10:00:00.000Z",
    consistency: "nonAtomicScan", scanned: 51,
    statuses: { requested: 0, open: 51, acknowledged: 0, resolved: 0, needsReview: 0, failed: 0 },
    overdue: 51, reviewRequired: 0, pendingChange: 0, alertPending: 0,
    alertUncertain: 0, alertFailed: 0 });
  assert.equal(JSON.stringify(health.value).includes("queue-call"), false);
  assert.equal(JSON.stringify(health.value).includes("Private"), false);
  const foreign = new CommandGateway({ actorRef: "foreign-agent", role: "agent", scope: { ...scope, tenantId: "foreign" } }, policy, reception, undefined, queue);
  const hidden = await foreign.submit({ kind: "staff.list.v1" });
  assert.ok(hidden.ok && hidden.value.kind === "staffQueue");
  assert.deepEqual(hidden.value.page.items, []);
  const foreignHealth = await foreign.submit({ kind: "staff.health.v1" });
  assert.ok(foreignHealth.ok && foreignHealth.value.kind === "staffQueueHealth");
  assert.equal(foreignHealth.value.health.scanned, 0);
  const noQueue = new CommandGateway({ actorRef: "no-queue-agent", role: "agent", scope }, policy, reception);
  assert.equal(noQueue.listPermitted().some(item => item.id === "staff.list.v1"), false);
  assert.deepEqual(await noQueue.submit({ kind: "staff.list.v1" }), { ok: false, error: { kind: "forbidden" } });
  assert.equal(noQueue.listPermitted().some(item => item.id === "staff.health.v1"), false);
  assert.deepEqual(await noQueue.submit({ kind: "staff.health.v1" }), { ok: false, error: { kind: "forbidden" } });
  assert.deepEqual(await agent.submit({ kind: "staff.health.v1", callId: "unexpected" } as never),
    { ok: false, error: { kind: "invalid" } });
  const invalid = await agent.submit({ kind: "staff.list.v1", afterTaskKey: "" });
  assert.ok(!invalid.ok);
  if (!invalid.ok) assert.equal(invalid.error.kind, "invalid");
});

test("E2E-263 a staff list storage failure is unavailable rather than a successful empty queue", async () => {
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const ledger = { listStaffItems: async () => err({ kind: "storageFailure" as const }) } as unknown as LedgerStore;
  const gateway = new CommandGateway({ actorRef: "queue-agent", role: "agent", scope }, policy, reception,
    undefined, new StaffQueue(ledger, () => now));
  assert.deepEqual(await gateway.submit({ kind: "staff.list.v1" }), { ok: false, error: { kind: "storageFailure" } });
});

test("queue health refuses an incomplete scan instead of reporting partial counts", async () => {
  const entries = Array.from({ length: 5_001 }, (_, index) => ({ callId: `call-${index}`,
    callVersion: 1, taskKey: `task-${String(index).padStart(5, "0")}`,
    reason: "callerRequested" as const, status: "open" as const,
    dueAt: now, destination: { kind: "queue" as const, queueRef: "operator" } }));
  const ledger = { listStaffItems: async (_scope: LocationScope, afterTaskKey?: string) =>
    ok(entries.filter(item => !afterTaskKey || item.taskKey > afterTaskKey).slice(0, 50)) } as unknown as LedgerStore;
  const result = await new StaffQueue(ledger, () => "2026-09-30T10:00:00.000Z").health(scope);
  assert.deepEqual(result, { ok: false, error: { kind: "storageFailure" } });
});
