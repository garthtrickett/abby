import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { twilioOutboundStopRecoveryFixture } from "../support/twilio-outbound-stop-recovery.ts";
import { value } from "../support/outbound-records.ts";
import { outboundDncRecordBinding } from "../../src/cliniko/outbound-dnc-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL), peer = connectPostgres(process.env.DATABASE_URL);
after(async () => { await Promise.all([db.destroy(), peer.destroy()]); });
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
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
for (const scenario of ["concurrent", "lostAck", "unstored", "grantLoss", "quota", "closed", "foreignCall"] as const)
test(`emitted signed native stop recovery with independent SQL and unfiltered backup privacy: ${scenario}`, { timeout: 30000 }, async t => {
  const apiKey = `synthetic-stop-recovery-${randomUUID()}-au5`, scope = { tenantId: `recover-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await twilioOutboundStopRecoveryFixture({ apiKey, scope, budget, StopOwner: ClinikoOutboundStopOwner, Policy: OwnerFileOutboundDncPolicy,
    runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign }, recoveryRuntime: { ClinikoTwilioOutboundStopRecovery, TwilioAbbyOutboundRuntime, TwilioOutboundReportAuthentication },
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) }); t.after(f.close);
  if (scenario === "lostAck") f.stopState.response = () => { throw Error("Synthetic DNC ACK lost"); };
  if (scenario === "unstored") f.stopState.beforeStore = () => { throw Error("Synthetic DNC write never observed"); };
  if (scenario === "grantLoss") f.stopState.beforeRecord = () => { f.reportState.live = false; };
  if (scenario === "closed") for (const row of [f.row, f.requestRow, f.reportRow]) {
    row.recalled = true; row.recalled_at = f.state.now; row.archived_at = f.state.now; row.updated_at = f.state.now;
  }
  if (scenario === "quota") for (let n = 0; n < 180; n++) if (await budget.claim() !== null) break;
  const make = (connection = db) => value(ClinikoTwilioOutboundStopRecovery.create(f.recoveryConfig, { ...f.recoveryPorts,
    effects: new PostgresOutboundEffectBarrier(connection, scope, outboundDncRecordBinding(f.recoveryConfig.stop.dnc)!) }));
  const recover = (connection = db) => make(connection).recoverStatus(f.request(scenario === "foreignCall" ? { CallSid: "CA" + "e".repeat(32) } : {}), new AbortController().signal);
  const results = scenario === "concurrent" ? await Promise.all([recover(db), recover(peer)]) : [await recover()];
  if (["grantLoss", "quota", "foreignCall"].includes(scenario)) { assert.equal(results[0]!.ok, false); assert.equal(f.dncPosts.length, 0); }
  else {
    assert.equal(f.dncPosts.length, 1);
    if (scenario === "concurrent") assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1);
    else assert.equal(value(results[0]!).kind, scenario === "lostAck" || scenario === "unstored" ? "uncertain" : "accepted");
    const cold = await recover(peer);
    if (scenario === "unstored") assert.equal(cold.ok, false); else assert.equal(value(cold).kind, "existingDecision");
    assert.equal(f.dncPosts.length, 1);
  }
  const effects = (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db)).rows;
  assert.equal(effects.filter(r => r.effect_ref === f.attempt.dncReferences!.actionRef).length, f.dncPosts.length);
  assert.equal(effects.some(r => r.effect_ref === f.attempt.dncReferences!.approvalRef || r.effect_ref === f.context.reportActionRef), false);
  const holds = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id = ${scope.tenantId}`.execute(db)).rows;
  assert.equal(holds.length, 1); assert.equal(holds[0]!.released_at, null); assert.equal(f.calls.length, 1);
  const canaries = [apiKey, f.context.number, f.callSid, f.context.attemptDigest, f.report.authentication, String(f.reportRow.notes), ...f.dncPosts.map(p => String(p.notes))];
  const chunks = canaries.flatMap((text, index) => Array.from({ length: Math.ceil(text.length / 256) }, (_, part) => {
    const chunk = text.slice(part * 256, (part + 1) * 256);
    return { label: `stop_recovery_${index}_${part}`, value: chunk.length < 4 ? text.slice(-4) : chunk };
  }));
  for (let offset = 0; offset < chunks.length; offset += 12)
    assert.deepEqual(await scanPatientDataCanaries(db, chunks.slice(offset, offset + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
});
