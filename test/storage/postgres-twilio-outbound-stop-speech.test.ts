import assert from "node:assert/strict";
import test, { after } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundContactGuardOwnerBinding } from "../../src/core/outbound-capacity.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL), peer = connectPostgres(process.env.DATABASE_URL);
after(async () => { await Promise.all([db.destroy(), peer.destroy()]); });
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { twilioOutboundStopSpeechFixture } = await import(new URL("test/support/twilio-outbound-stop-speech.js", emitted).href) as typeof import("../support/twilio-outbound-stop-speech.ts");
const { PostgresOutboundCapacity } = await import(new URL("src/storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { ClinikoTwilioOutboundStopRecovery } = await import(new URL("src/standalone/cliniko-twilio-outbound-stop-recovery.js", emitted).href) as typeof import("../../src/standalone/cliniko-twilio-outbound-stop-recovery.ts");
const { TwilioOutboundReportAuthentication, decodeTwilioOutboundReport } = await import(new URL("src/cliniko/twilio-outbound-report.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-report.ts");
const { outboundDncRecordBinding } = await import(new URL("src/cliniko/outbound-dnc-records.js", emitted).href) as typeof import("../../src/cliniko/outbound-dnc-records.ts");

for (const scenario of ["accepted", "reportStored", "reportUnstored", "decisionStored", "decisionUnstored", "reportGrant", "decisionGrant", "quota", "parallelCold", "unclearStop"] as const)
test(`emitted signed voice produces native stop/DNC with SQL one-use holds and full backup privacy: ${scenario}`, { timeout: 30000 }, async t => {
  const apiKey = `synthetic-stop-speech-${randomUUID()}-au5`, scope = { tenantId: `speech-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const guardRef = randomUUID(), budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
  const text = "Please, remove my number from your calling list.";
  const f = await twilioOutboundStopSpeechFixture({ apiKey, scope, budget, patientId, guardRef, text,
    ...(scenario === "unclearStop" ? { quality: "needsClarification" } : {}),
    ...(scenario === "reportStored" ? { reportResponse: "lostStored" } : scenario === "reportUnstored" ? { reportResponse: "lostUnstored" } : {}),
    ...(scenario === "decisionStored" ? { decisionResponse: "lostStored" } : scenario === "decisionUnstored" ? { decisionResponse: "lostUnstored" } : {}),
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b),
    capacity: new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(guardRef)!) });
  t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  if (scenario === "reportGrant") f.stateSpeech.report = false;
  if (scenario === "decisionGrant" || scenario === "parallelCold") f.stateSpeech.decision = false;
  if (scenario === "quota") for (let n = 0; n < 180; n++) if (await budget.claim() !== null) break;
  const closed = once(wire.socket, "close"); wire.sendTurn(); await closed; await f.finished;
  assert.deepEqual(f.intents, []); assert.equal(f.spoken.length, 1); assert.equal(f.carrierCalls, 1);
  assert.equal(f.reportPosts.length, ["reportGrant", "quota", "unclearStop"].includes(scenario) ? 0 : 1);
  assert.equal(f.dncPosts.length, ["reportUnstored", "reportGrant", "decisionGrant", "quota", "parallelCold", "unclearStop"].includes(scenario) ? 0 : 1);
  const original = f.original(), auth = new TwilioOutboundReportAuthentication(f.key, f.attempt.provider);
  const makeCold = (connection = db) => value(ClinikoTwilioOutboundStopRecovery.create(f.config, { ...f.ports,
    runtime: f.runtime, authentication: auth, effects: new PostgresOutboundEffectBarrier(connection, scope, outboundDncRecordBinding(f.config.stop.dnc)!) }));
  const recover = (connection = db) => makeCold(connection).recoverRetainedReport(original, f.carrier.accountSid, f.callSid, new AbortController().signal);
  if (scenario === "parallelCold") {
    f.stateSpeech.decision = true;
    const results = await Promise.all([recover(db), recover(peer)]);
    assert.ok(results.some(r => r.ok && ["accepted", "existingDecision"].includes(r.value.outcome.kind)));
    assert.equal(f.dncPosts.length, 1); assert.equal(value(await recover(peer)).outcome.kind, "existingDecision");
  } else if (["accepted", "reportStored", "decisionStored"].includes(scenario)) {
    assert.equal(value(await recover(peer)).outcome.kind, "existingDecision");
  } else if (scenario === "decisionUnstored") {
    assert.equal((await recover(peer)).ok, false); assert.equal(f.dncPosts.length, 1);
  } else if (scenario === "reportUnstored") {
    assert.equal(value(await recover(peer)).outcome.kind, "unresolved"); assert.equal(f.dncPosts.length, 0);
  }
  const effects = (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db)).rows;
  assert.equal(effects.filter(r => r.effect_ref === original.sessionActionRef).length, 1);
  assert.equal(effects.filter(r => r.effect_ref === original.reportActionRef).length, f.reportPosts.length);
  assert.equal(effects.filter(r => r.effect_ref === f.attempt.dncReferences!.actionRef).length, f.dncPosts.length);
  assert.equal(effects.some(r => r.effect_ref === f.attempt.dncReferences!.approvalRef), false);
  const holds = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id = ${scope.tenantId}`.execute(db)).rows;
  assert.equal(holds.length, 2); assert.ok(holds.every(r => r.released_at === null));
  const report = f.contactControls.rows.find(row => String(row.id) === "250");
  const canaries = [apiKey, patientId, original.number, f.callSid, original.attemptDigest, text, f.key.toString("hex"), f.carrier.contextKey.toString("hex"), f.carrier.authToken,
    f.form.get("Url")!, f.form.get("StatusCallback")!, f.form.toString(), f.admitted!.receipt.callId, f.admitted!.sessionId,
    ...f.reportPosts.flatMap(p => [String(p.notes), value(decodeTwilioOutboundReport(p.notes)).authentication]),
    ...f.dncPosts.map(p => String(p.notes)), ...(report ? [String(report.notes)] : [])];
  const chunks = canaries.flatMap((text, index) => Array.from({ length: Math.ceil(text.length / 256) }, (_, part) => {
    const chunk = text.slice(part * 256, (part + 1) * 256);
    return { label: `stop_speech_${index}_${part}`, value: chunk.length < 4 ? text.slice(-4) : chunk };
  }));
  for (let offset = 0; offset < chunks.length; offset += 12)
    assert.deepEqual(await scanPatientDataCanaries(db, chunks.slice(offset, offset + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
});
