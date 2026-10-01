import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { StandaloneOperationalCounters } from "../../src/standalone/operational-counters.ts";
import type { OperationalDailyCounts } from "../../src/voice/operational-counts.ts";

const scope = { tenantId: "ops-tenant", clinicId: "ops-clinic", locationId: "front" };

test("E2E-235 agent-native operational read binds clinic scope and rejects malformed evidence", async () => {
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const counters = new StandaloneOperationalCounters(() => "2026-10-01T12:00:00.000Z");
  counters.record(scope, "callOwnerStarted");
  counters.record({ ...scope, locationId: "other" }, "voiceFailure");
  let malformed = false;
  let unavailable = false;
  const reader = { daily: (location: typeof scope): OperationalDailyCounts => {
    if (unavailable) throw new Error("private database detail");
    if (malformed) return { days: [], patientNote: "private patient canary" } as unknown as OperationalDailyCounts;
    return counters.daily(location);
  } };
  const gateway = (role: "clinicAdmin" | "staff" | "agent", location = scope) =>
    new CommandGateway({ actorRef: `ops-${role}`, role, scope: location }, policy, reception,
      undefined, undefined, undefined, undefined, undefined, undefined, reader);
  const admin = gateway("clinicAdmin");
  assert.equal(admin.listPermitted().some(item => item.id === "operations.daily.v1"), true);
  const result = await admin.submit({ kind: "operations.daily.v1" });
  assert.ok(result.ok && result.value.kind === "operationalDaily");
  assert.equal(result.value.daily.days.at(-1)?.counts.callOwnerStarted, 1);
  assert.equal(result.value.daily.days.at(-1)?.counts.voiceFailure, 0);
  const foreign = await gateway("clinicAdmin", { ...scope, locationId: "other" })
    .submit({ kind: "operations.daily.v1" });
  assert.ok(foreign.ok && foreign.value.kind === "operationalDaily");
  assert.equal(foreign.value.daily.days.at(-1)?.counts.callOwnerStarted, 0);
  assert.equal(foreign.value.daily.days.at(-1)?.counts.voiceFailure, 1);
  for (const role of ["staff", "agent"] as const) {
    assert.equal(gateway(role).listPermitted().some(item => item.id === "operations.daily.v1"), false);
    assert.deepEqual(await gateway(role).submit({ kind: "operations.daily.v1" }),
      { ok: false, error: { kind: "forbidden" } });
  }
  assert.deepEqual(await admin.submit({ kind: "operations.daily.v1", scope: { ...scope, locationId: "other" } } as never),
    { ok: false, error: { kind: "invalid" } });
  malformed = true;
  assert.deepEqual(await admin.submit({ kind: "operations.daily.v1" }),
    { ok: false, error: { kind: "responseContractViolation" } });
  malformed = false;
  unavailable = true;
  assert.deepEqual(await admin.submit({ kind: "operations.daily.v1" }),
    { ok: false, error: { kind: "commandOutcomeUnknown" } });
  const absent = new CommandGateway({ actorRef: "ops-unconfigured", role: "clinicAdmin", scope }, policy, reception);
  assert.equal(absent.listPermitted().some(item => item.id === "operations.daily.v1"), false);
});
