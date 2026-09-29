import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("standalone ledger cannot expose legacy voice, effect, or staff payloads", async () => {
  const scope = { tenantId: `legacy-read-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
  const callId = randomUUID();
  const privateText = `patient-private-legacy-${randomUUID()}`;
  const effectId = randomUUID();
  const taskKey = randomUUID();
  const pendingId = randomUUID();
  const now = "2026-09-29T10:00:00Z";
  await sql`insert into calls (call_id, tenant_id, clinic_id, location_id, version, policy_version, state)
    values (${callId}, ${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, 0, '0',
      ${JSON.stringify({ callId, lifecycle: "active", version: 0, policy: { scope, policyVersion: "0" },
        callerMessages: [privateText] })}::jsonb)`.execute(db);
  await sql`insert into pending_location_calls (call_id, tenant_id, clinic_id, status, state)
    values (${pendingId}, ${scope.tenantId}, ${scope.clinicId}, 'pending',
      ${JSON.stringify({ callId: pendingId, status: "pending", route: { tenantId: scope.tenantId,
        clinicId: scope.clinicId }, callerSpeech: privateText })}::jsonb)`.execute(db);
  await sql`insert into effect_outbox (effect_id, call_id, tenant_id, kind, status, payload)
    values (${effectId}, ${callId}, ${scope.tenantId}, 'hostWrite', 'pending',
      ${JSON.stringify({ id: effectId, kind: "hostWrite", status: "pending", request: privateText })}::jsonb)`.execute(db);
  await sql`insert into staff_items (task_key, call_id, tenant_id, status, payload)
    values (${taskKey}, ${callId}, ${scope.tenantId}, 'open',
      ${JSON.stringify({ key: taskKey, scope, status: "open", dueAt: now,
        destination: { kind: "queue", queueRef: "frontdesk" }, reason: privateText })}::jsonb)`.execute(db);

  const ledger = new PostgresLedger(db);
  const rejected = { ok: false, error: { kind: "invalidTransition" } };
  const requests = [
    ledger.findPendingLocation(callId),
    ledger.attachPendingLocationSession(callId, "session", now),
    ledger.renewPendingLocationSession(callId, "session", 1, now),
    ledger.startPendingLocationPrompt(callId, "playback", "session", 1, now),
    ledger.resolvePendingLocationPrompt(callId, "playback", "session", 1, "played", now),
    ledger.closePendingLocationSession(callId, "session", 1, "callerDisconnected", now),
    ledger.findExpiredPendingLocations(now, scope),
    ledger.expirePendingLocation(callId, now),
    ledger.findExpiredAdmissions(now, scope),
    ledger.findExpiredSessions(now, scope),
    ledger.findPendingPresentations(now, scope),
    ledger.findRecoverableEffects(now, scope),
    ledger.listStaffItems(scope),
  ];
  for (const result of await Promise.all(requests)) assert.deepEqual(result, rejected);
  assert.deepEqual(await ledger.read(callId, scope), { ok: false, error: { kind: "storageCorrupt" } });
  assert.deepEqual(await ledger.listCalls(scope), { ok: false, error: { kind: "storageCorrupt" } });
  assert.deepEqual(await ledger.findAdmission(callId), { ok: false, error: { kind: "storageCorrupt" } });
});
