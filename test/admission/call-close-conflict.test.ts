import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { err } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";

const now = "2026-10-01T10:00:00.000Z";
async function activeCall() {
  const scope = { tenantId: randomUUID(), clinicId: "clinic", locationId: "main" };
  const ledger = new MemoryLedger(), callId = randomUUID(), sessionId = "owner";
  const runtime = new CallRuntime(ledger, scope);
  assert.ok((await runtime.admit(callId, referenceDefaultPolicy(scope), {
    key: { accountRef: "synthetic", providerCallRef: callId }, dialedNumber: "+6125550101",
    acceptedAt: now, deadline: "2026-10-01T10:01:00.000Z",
  })).ok);
  assert.ok((await runtime.activate(callId, sessionId, now)).ok);
  return { ledger, runtime, scope, callId, sessionId };
}

test("call close re-reads after a competing local transition and ends the same owned session", async () => {
  const app = await activeCall(); let attempts = 0;
  const ledger: LedgerStore = new Proxy(app.ledger, { get(target, key) {
    if (key === "apply") return async (...args: Parameters<LedgerStore["apply"]>) => {
      if (args[3].kind === "callEnded" && ++attempts === 1) {
        assert.ok((await app.runtime.beginSpeech(app.callId, app.sessionId, now)).ok);
      }
      return target.apply(...args);
    };
    const member = Reflect.get(target, key);
    return typeof member === "function" ? member.bind(target) : member;
  } });
  const result = await new CallRuntime(ledger, app.scope).endCall(app.callId, app.sessionId, now, "callerDisconnected");
  assert.ok(result.ok); assert.equal(result.value.lifecycle, "ended"); assert.equal(attempts, 2);
});

test("call close never retries another owner's rejection", async () => {
  const app = await activeCall();
  assert.deepEqual(await app.runtime.endCall(app.callId, "other-owner", now), err({ kind: "leaseLost" }));
  const current = await app.runtime.read(app.callId); assert.ok(current.ok); assert.equal(current.value.lifecycle, "active");
});

test("call close bounds repeated conflicts without reporting a terminal state", async () => {
  const app = await activeCall(); let attempts = 0;
  const ledger: LedgerStore = new Proxy(app.ledger, { get(target, key) {
    if (key === "apply") return async () => { attempts++; return err({ kind: "versionConflict" as const }); };
    const member = Reflect.get(target, key);
    return typeof member === "function" ? member.bind(target) : member;
  } });
  assert.deepEqual(await new CallRuntime(ledger, app.scope).endCall(app.callId, app.sessionId, now), err({ kind: "versionConflict" }));
  assert.equal(attempts, 3);
  const current = await app.runtime.read(app.callId); assert.ok(current.ok); assert.equal(current.value.lifecycle, "active");
});
