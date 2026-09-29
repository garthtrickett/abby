import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("standalone text response and caller content do not enter PostgreSQL", async () => {
  const scope = { tenantId: "safe-ledger-tenant", clinicId: "safe-ledger-clinic", locationId: "safe-ledger-location" };
  const callId = randomUUID();
  const now = "2026-09-29T10:00:00.000Z";
  const callerText = `caller-private-text-${randomUUID()}`;
  const answerText = `patient-private-answer-${randomUUID()}`;
  const greetingText = `patient-private-greeting-${randomUUID()}`;
  const sourceRef = "clinic-hours";
  const policy = {
    ...referenceDefaultPolicy(scope),
    capabilities: { book: "unavailable", cancel: "unavailable", reschedule: "unavailable", intake: "unavailable", transfer: "unavailable" } as const,
    staffWorkEnabled: false,
    greeting: { scope, version: "test", ownerRef: "test", approvedText: greetingText, approved: true as const },
  };
  const ledger = new PostgresLedger(db);
  const runtime = new CallRuntime(ledger, scope);
  const started = await runtime.start(callId, policy);
  assert.equal(started.ok, true, started.ok ? "" : started.error.kind);
  if (!started.ok) return;
  assert.equal(started.value.policy.greeting, undefined);
  const unsafeStart = await runtime.start(randomUUID(), { ...policy,
    capabilities: { ...policy.capabilities, book: "execute" } });
  assert.deepEqual(unsafeStart, { ok: false, error: { kind: "invalidTransition" } });

  const answered = await runtime.acceptTurn({ callId, turnId: randomUUID(), text: callerText, quality: "clear", at: now }, {
    kind: "answer",
    sources: [{ scope, sourceRef, version: "1", ownerRef: "clinic", approvedText: answerText,
      approved: true, effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-10-01T00:00:00.000Z" }],
    proposedText: answerText,
  }, now);
  assert.equal(answered.ok, true, answered.ok ? "" : answered.error.kind);
  if (!answered.ok) return;
  assert.equal(answered.value.callerMessages.at(-1), answerText);
  const loaded = await new PostgresLedger(db).read(callId, scope);
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error.kind);
  if (!loaded.ok) return;
  assert.deepEqual(loaded.value.callerMessages, []);
  assert.deepEqual(loaded.value.knowledgeAnswers, []);
  assert.deepEqual(Object.values(loaded.value.presentations).map(item => item.kind === "notice" ? item.approvedText : "unexpected"), [""]);

  const unsafeTurnId = `patient-private-turn-${randomUUID()}`;
  const rejected = await runtime.acceptTurn({ callId, turnId: unsafeTurnId, text: callerText, quality: "clear", at: now },
    { kind: "clarify" }, now);
  assert.deepEqual(rejected, { ok: false, error: { kind: "invalidTransition" } });
  const scan = await scanPatientDataCanaries(db, [
    { label: "caller_text", value: callerText }, { label: "answer", value: answerText },
    { label: "greeting", value: greetingText }, { label: "turn_id", value: unsafeTurnId },
  ]);
  assert.deepEqual(scan, { ok: true, value: [] });
});

test("standalone write-stop audit accepts only operational reason codes", async () => {
  const scope = { tenantId: `reason-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
  const privateReason = `patient-private-stop-${randomUUID()}`;
  const ledger = new PostgresLedger(db, undefined, async () => ok(true));
  assert.deepEqual(await ledger.stopWrites(scope, "operator", privateReason),
    { ok: false, error: { kind: "invalidTransition" } });
  assert.equal((await sql`select 1 from clinic_write_stop where tenant_id = ${scope.tenantId}`.execute(db)).rows.length, 0);

  const stopped = await ledger.stopWrites(scope, "operator", "operatorStop");
  assert.equal(stopped.ok && stopped.value.stopped, true);
  assert.deepEqual(await ledger.resumeWrites(scope, "1", "operator", privateReason),
    { ok: false, error: { kind: "invalidTransition" } });
  const stillStopped = await ledger.readWriteStop(scope);
  assert.equal(stillStopped.ok && stillStopped.value.stopped, true);
  const resumed = await ledger.resumeWrites(scope, "1", "operator", "operatorResume");
  assert.equal(resumed.ok && !resumed.value.stopped, true);
  const reasons = await sql<{ reason: string }>`select reason from clinic_write_stop_events
    where tenant_id = ${scope.tenantId} order by version`.execute(db);
  assert.deepEqual(reasons.rows.map(row => row.reason), ["operatorStop", "operatorResume"]);
  assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "reason", value: privateReason }]),
    { ok: true, value: [] });
});
