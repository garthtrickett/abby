import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { StaffQueue } from "../../src/reference/staff-queue.ts";
import { TextReception } from "../../src/reference/text-reception.ts";

const scope: LocationScope = { tenantId: "queue-tenant", clinicId: "queue-clinic", locationId: "queue-location" };
const now = "2026-09-28T10:00:00.000Z";

test("scoped staff queue paginates redacted follow-up and exposes overdue work to agents", async () => {
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
  const foreign = new CommandGateway({ actorRef: "foreign-agent", role: "agent", scope: { ...scope, tenantId: "foreign" } }, policy, reception, undefined, queue);
  const hidden = await foreign.submit({ kind: "staff.list.v1" });
  assert.ok(hidden.ok && hidden.value.kind === "staffQueue");
  assert.deepEqual(hidden.value.page.items, []);
  const invalid = await agent.submit({ kind: "staff.list.v1", afterTaskKey: "" });
  assert.ok(!invalid.ok);
  if (!invalid.ok) assert.equal(invalid.error.kind, "invalid");
});
