import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { twilioOutboundStopReceiverFixture } from "../support/twilio-outbound-stop-receiver.ts";
import { value } from "../support/outbound-records.ts";
import { outboundDncRecordBinding } from "../../src/cliniko/outbound-dnc-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL), peer = connectPostgres(process.env.DATABASE_URL);
after(async () => { await Promise.all([db.destroy(), peer.destroy()]); });
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { twilioOutboundStopReceiver } = await import(new URL("standalone/twilio-outbound-stop-receiver.js", emitted).href) as typeof import("../../src/standalone/twilio-outbound-stop-receiver.ts");
const { createTwilioIngressServer } = await import(new URL("voice/twilio-ingress-server.js", emitted).href) as typeof import("../../src/voice/twilio-ingress-server.ts");
const { TwilioSignedIngress } = await import(new URL("voice/twilio-signed-ingress.js", emitted).href) as typeof import("../../src/voice/twilio-signed-ingress.ts");
const { ClinikoTwilioOutboundStopRecovery } = await import(new URL("standalone/cliniko-twilio-outbound-stop-recovery.js", emitted).href) as typeof import("../../src/standalone/cliniko-twilio-outbound-stop-recovery.ts");
const { TwilioAbbyOutboundRuntime } = await import(new URL("voice/twilio-outbound-runtime.js", emitted).href) as typeof import("../../src/voice/twilio-outbound-runtime.ts");
const { TwilioOutboundReportAuthentication } = await import(new URL("cliniko/twilio-outbound-report.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-report.ts");
const { ClinikoOutboundStopOwner } = await import(new URL("standalone/cliniko-outbound-stop-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-stop-owner.ts");
const { OwnerFileOutboundDncPolicy } = await import(new URL("standalone/owner-file-outbound-dnc-policy.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-dnc-policy.ts");
const { ClinikoOutboundLaunchOwner } = await import(new URL("standalone/cliniko-outbound-launch-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const { OwnerFileOutboundCampaign } = await import(new URL("standalone/owner-file-outbound-campaign.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const { PostgresOutboundCapacity } = await import(new URL("storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");

for (const scenario of ["concurrent", "lateReport", "lostAck", "unstored", "grantLoss", "quota", "noStop"] as const)
test(`emitted actual signed HTTP stop receiver with SQL exclusion and backup privacy: ${scenario}`, { timeout: 30000 }, async t => {
  const apiKey = `synthetic-stop-receiver-${randomUUID()}-au5`, scope = { tenantId: `receiver-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
  const f = await twilioOutboundStopReceiverFixture({ apiKey, scope, budget, patientId, StopOwner: ClinikoOutboundStopOwner, Policy: OwnerFileOutboundDncPolicy,
    runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign },
    recoveryRuntime: { ClinikoTwilioOutboundStopRecovery, TwilioAbbyOutboundRuntime, TwilioOutboundReportAuthentication },
    receiverRuntime: { twilioOutboundStopReceiver, TwilioSignedIngress, createTwilioIngressServer },
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) });
  t.after(f.closeReceiver);
  const make = (connection = db) => value(ClinikoTwilioOutboundStopRecovery.create(f.recoveryConfig, { ...f.recoveryPorts,
    effects: new PostgresOutboundEffectBarrier(connection, scope, outboundDncRecordBinding(f.recoveryConfig.stop.dnc)!) }));
  const a = await f.listen(make(db));
  if (scenario === "lostAck") f.stopState.response = () => { throw Error("Synthetic native ACK lost"); };
  if (scenario === "unstored") f.stopState.beforeStore = () => { throw Error("Synthetic native write never observed"); };
  if (scenario === "grantLoss") f.stopState.beforeRecord = () => { f.reportState.live = false; };
  if (scenario === "quota") for (let n = 0; n < 180; n++) if (await budget.claim() !== null) break;
  if (scenario === "noStop") f.replaceReport({ terminal: { endedAt: f.state.now, observedAt: f.state.now }, contact: { kind: "completeNoStop" } });
  if (scenario === "lateReport") {
    f.contactControls.rows.splice(f.contactControls.rows.indexOf(f.reportRow), 1);
    assert.equal((await a.post()).status, 503); assert.equal(f.dncPosts.length, 0);
    f.contactControls.rows.push(f.reportRow);
  }
  if (scenario === "concurrent") {
    const b = await f.listen(make(peer)), responses = await Promise.all([a.post(), b.post()]);
    assert.ok(responses.some(r => r.status === 204)); assert.ok(responses.every(r => r.status === 204 || r.status === 503));
    assert.equal(f.dncPosts.length, 1); assert.equal((await b.post()).status, 204);
  } else {
    const response = await a.post(); assert.equal(response.status, ["lostAck", "unstored", "grantLoss", "quota"].includes(scenario) ? 503 : 204);
    if (scenario === "lostAck") assert.equal((await a.post()).status, 204);
    if (scenario === "unstored") assert.equal((await a.post()).status, 503);
    assert.equal(f.dncPosts.length, ["grantLoss", "quota", "noStop"].includes(scenario) ? 0 : 1);
  }
  const effects = (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db)).rows;
  assert.equal(effects.filter(r => r.effect_ref === f.attempt.dncReferences!.actionRef).length, f.dncPosts.length);
  assert.equal(effects.some(r => r.effect_ref === f.attempt.dncReferences!.approvalRef || r.effect_ref === f.context.reportActionRef || r.effect_ref === f.context.sessionActionRef), false);
  const holds = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id = ${scope.tenantId}`.execute(db)).rows;
  assert.equal(holds.length, 1); assert.equal(holds[0]!.released_at, null); assert.equal(f.calls.length, 1);
  const canaries = [apiKey, patientId, f.context.number, f.callSid, f.context.attemptDigest, f.report.authentication, f.key.toString("hex"),
    f.carrier.contextKey.toString("hex"), f.carrier.authToken, f.request().requestTarget, f.request().body, f.request().signature,
    String(f.reportRow.notes), ...f.dncPosts.map(p => String(p.notes))];
  const chunks = canaries.flatMap((text, index) => Array.from({ length: Math.ceil(text.length / 256) }, (_, part) => {
    const chunk = text.slice(part * 256, (part + 1) * 256);
    return { label: `stop_receiver_${index}_${part}`, value: chunk.length < 4 ? text.slice(-4) : chunk };
  }));
  for (let offset = 0; offset < chunks.length; offset += 12)
    assert.deepEqual(await scanPatientDataCanaries(db, chunks.slice(offset, offset + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
});
