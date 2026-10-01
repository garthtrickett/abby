import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { CallRuntime } from "../../src/core/runtime.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { callIdFor } from "../../src/voice/admission.ts";

const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });

test("E2E-070 PostgreSQL reference call persists one silence retry and one final notice", { skip: !db }, async () => {
  const now = "2026-09-29T10:00:00.000Z";
  const scope = { tenantId: `silence-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const policy = referenceDefaultPolicy(scope);
  const ledger = new PostgresLedger(db!, suggested => suggested, undefined, "unsafeReference");
  const runtime = new CallRuntime(ledger, scope);
  const key = { accountRef: `account-${randomUUID()}`, providerCallRef: `call-${randomUUID()}` };
  const callId = callIdFor(key);
  const admitted = await runtime.admit(callId, policy, { key, dialedNumber: "+6125550199", acceptedAt: now,
    deadline: "2026-09-29T10:00:30.000Z" });
  assert.ok(admitted.ok);
  assert.ok((await runtime.activate(callId, "session", now)).ok);
  const greetingId = `${callId}:greeting`;
  assert.ok((await runtime.startPresentation(callId, greetingId, "session", now)).ok);
  assert.ok((await runtime.resolvePresentation(callId, greetingId, "played", "session", now)).ok);
  const prematureFinal = await runtime.silenceTimeout(callId, "session", "final", now);
  assert.ok(!prematureFinal.ok);
  assert.equal(prematureFinal.error.kind, "invalidTransition");
  const retry = await runtime.silenceTimeout(callId, "session", "retry", now);
  assert.ok(retry.ok);
  const retryId = retry.value.pendingPresentationId;
  assert.ok(retryId);
  assert.ok((await runtime.startPresentation(callId, retryId, "session", now)).ok);
  assert.ok((await runtime.resolvePresentation(callId, retryId, "played", "session", now)).ok);
  const final = await runtime.silenceTimeout(callId, "session", "final", now);
  assert.ok(final.ok);
  const finalId = final.value.pendingPresentationId;
  assert.ok(finalId);
  assert.ok((await runtime.startPresentation(callId, finalId, "session", now)).ok);
  assert.ok((await runtime.resolvePresentation(callId, finalId, "played", "session", now)).ok);
  assert.ok((await runtime.endCall(callId, "session", now, "sessionClosed")).ok);
  const persisted = await runtime.read(callId);
  assert.ok(persisted.ok);
  assert.equal(persisted.value.lifecycle, "ended");
  assert.deepEqual([persisted.value.presentations[retryId]?.status,
    persisted.value.presentations[finalId]?.status], ["played", "played"]);
  assert.equal(persisted.value.processedTurnIds.length, 0);
  assert.deepEqual(persisted.value.callerMessages, [], "settled notice wording is redacted after closure");
});
