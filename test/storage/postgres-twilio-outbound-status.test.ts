import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { twilioOutboundStatusVoiceFixture } = await import(new URL("test/support/twilio-outbound-status-voice.js", emitted).href) as typeof import("../support/twilio-outbound-status-voice.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresOutboundCapacity } = await import(new URL("src/storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { outboundContactGuardOwnerBinding } = await import(new URL("src/core/outbound-capacity.js", emitted).href) as typeof import("../../src/core/outbound-capacity.ts");
const { twilioOutboundTerminalActionRef } = await import(new URL("src/cliniko/twilio-outbound-terminal-observation.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-terminal-observation.ts");

for (const scenario of ["accepted", "unclear", "decisionStored", "decisionUnstored", "notificationStored", "notificationUnstored", "signature", "source", "quota", "parallel"] as const)
test(`actual emitted voice producer and signed callback retain independent native truth with SQL privacy: ${scenario}`, { timeout: 60000 }, async t => {
  const apiKey = `synthetic-status-${randomUUID()}-au5`, scope = { tenantId: `status-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
  const guardRef = randomUUID(), budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 }), text = "Please remove my number from your calling list.";
  const f = await twilioOutboundStatusVoiceFixture({ apiKey, scope, patientId, guardRef, budget, text,
    ...(scenario === "unclear" ? { quality: "needsClarification" } : {}),
    ...(scenario === "decisionStored" ? { decisionResponse: "lostStored" } : scenario === "decisionUnstored" ? { decisionResponse: "lostUnstored" } : {}),
    ...(scenario === "notificationStored" ? { notificationResponse: "lostStored" } : scenario === "notificationUnstored" ? { notificationResponse: "lostUnstored" } : {}),
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b),
    capacity: new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(guardRef)!) });
  t.after(f.close);
  // The actual voice producer retains speech first. The signed callback, rather
  // than the earlier in-process recovery, must make the restrictive decision.
  f.stateSpeech.decision = false;
  const voice = await f.listen(); t.after(voice.close); const wire = await f.start(voice), closed = once(wire.socket, "close");
  wire.sendTurn(); await closed; await f.finished;
  assert.equal(f.reportPosts.length, scenario === "unclear" ? 0 : 1); assert.equal(f.dncPosts.length, 0);
  assert.equal(f.carrierCalls, 1); assert.deepEqual(f.intents, []); assert.equal(f.spoken.length, 1);
  f.stateSpeech.decision = true;
  if (scenario === "source") f.notificationState.source = false;
  if (scenario === "quota") for (let n = 0; n < 180; n++) if (await budget.claim() !== null) break;
  const callback = await f.listenStatus(); t.after(callback.close);
  if (scenario === "signature") {
    assert.equal(await callback.send({ ...f.statusRequest(), signature: "forged" }), 403);
    assert.equal(f.dncPosts.length, 0); assert.equal(f.notificationPosts.length, 0);
    assert.equal(await callback.send(), 204);
  } else if (scenario === "parallel") {
    const responses = await Promise.all([callback.send(), callback.send()]); assert.ok(responses.includes(204));
    assert.ok(responses.every(status => status === 204 || status === 503)); assert.equal(await callback.send(), 204);
  } else {
    const first = await callback.send();
    assert.equal(first, ["decisionStored", "decisionUnstored", "notificationUnstored", "source", "quota"].includes(scenario) ? 503 : 204);
    assert.equal(await callback.send(), ["decisionUnstored", "notificationUnstored", "source", "quota"].includes(scenario) ? 503 : 204);
  }
  assert.equal(f.dncPosts.length, ["unclear", "quota"].includes(scenario) ? 0 : 1);
  assert.equal(f.notificationPosts.length, ["decisionUnstored", "source", "quota"].includes(scenario) ? 0 : 1);
  const original = f.original(), action = twilioOutboundTerminalActionRef(original.sessionActionRef);
  assert.ok(action);
  const effects = (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(effects.filter(r => r.effect_ref === original.sessionActionRef).length, 1);
  assert.equal(effects.filter(r => r.effect_ref === original.reportActionRef).length, f.reportPosts.length);
  assert.equal(effects.filter(r => r.effect_ref === f.attempt.dncReferences!.actionRef).length, f.dncPosts.length);
  assert.equal(effects.filter(r => r.effect_ref === action).length, f.notificationPosts.length);
  const holds = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(holds.length, 2); assert.ok(holds.every(row => row.released_at === null)); assert.equal(f.carrierCalls, 1);
  const request = f.statusRequest(), canaries = [apiKey, patientId, original.number, f.callSid, original.attemptDigest, text,
    f.key.toString("hex"), f.notificationKey.toString("hex"), f.carrier.contextKey.toString("hex"), f.carrier.authToken,
    f.form.get("Url")!, f.form.get("StatusCallback")!, f.form.toString(), request.body, request.signature,
    f.admitted!.receipt.callId, f.admitted!.sessionId, ...f.contactControls.rows.map(row => String(row.notes)),
    ...f.reportPosts.map(p => String(p.notes)), ...f.dncPosts.map(p => String(p.notes)), ...f.notificationPosts.map(p => String(p.notes))];
  const chunks = canaries.flatMap((raw, i) => Array.from({ length: Math.ceil(raw.length / 256) }, (_, j) => ({ label: `status_${i}_${j}`,
    value: raw.slice(j * 256, (j + 1) * 256).length < 4 ? raw.slice(-4) : raw.slice(j * 256, (j + 1) * 256) })));
  for (let i = 0; i < chunks.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, chunks.slice(i, i + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  const copy = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const value of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(value), false); }
});
