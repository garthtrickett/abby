import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { assertNotificationPrivacy } from "../support/outbound-notification-privacy.ts";
import { outboundRequestValue } from "../support/outbound-recipient-request.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL), peer = connectPostgres(process.env.DATABASE_URL);
after(async () => { await Promise.all([db.destroy(), peer.destroy()]); });
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { twilioNotificationRecoveryFixture } = await import(new URL("test/support/twilio-outbound-notification-recovery.js", emitted).href) as typeof import("../support/twilio-outbound-notification-recovery.ts");
const { PostgresOutboundCapacity } = await import(new URL("src/storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { outboundCapacityOwnerBinding, outboundContactGuardOwnerBinding } = await import(new URL("src/core/outbound-capacity.js", emitted).href) as typeof import("../../src/core/outbound-capacity.ts");
const { recoverTwilioOutboundNotification } = await import(new URL("src/standalone/cliniko-twilio-outbound-notification-recovery.js", emitted).href) as typeof import("../../src/standalone/cliniko-twilio-outbound-notification-recovery.ts");
const { ClinikoTwilioOutboundTerminalObservationRecords, twilioOutboundTerminalObservationRecordBinding } = await import(new URL("src/cliniko/twilio-outbound-terminal-observation-records.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-terminal-observation-records.ts");
const { decodeTwilioOutboundTerminalObservation, TwilioOutboundTerminalObservationAuthentication } = await import(new URL("src/cliniko/twilio-outbound-terminal-observation.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-terminal-observation.ts");

for (const scenario of ["accepted", "stored", "unstored", "child", "sourceDenied", "withdrawnAtSql", "parallelCold", "newSelections"] as const)
test(`emitted authenticated notification recovers only provider-proven SQL capacity: ${scenario}`, { timeout: 120000 }, async () => {
  const original = outboundRequestValue(), scope = { ...original.scope, tenantId: `notification-${randomUUID()}` },
    patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
  const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-outbound-au5", maxPerMinute: 180 });
  const until = Date.now() + 75000;
  while (await budget.checkHeadroom(40) !== null) { assert.ok(Date.now() < until, "wait only for real physical budget40"); await new Promise(r => setTimeout(r, 250)); }
  const f = await twilioNotificationRecoveryFixture({ request: { ...original, scope, patientId }, budget,
    effectsFactory: (s, owner) => new PostgresOutboundEffectBarrier(db, s, owner),
    ...(scenario === "stored" || scenario === "unstored" ? { lostAck: scenario } : {}) });
  const a = f.original.attempt, call = new PostgresOutboundCapacity(db, scope, outboundCapacityOwnerBinding(a.campaignRef)!),
    contact = new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(a.contactReferences!.guardRef)!);
  assert.equal(value(await call.acquireOnce(a.capacityAllocationRef!, 1)).kind, "acquired");
  assert.equal(value(await contact.acquireOnce(a.contactReferences!.allocationRef, 1)).kind, "acquired");
  if (scenario === "child") f.recoveryState.child = true;
  if (scenario === "sourceDenied") f.recoveryState.source = false;
  if (scenario === "withdrawnAtSql") f.recoveryState.beforeRelease = () => { f.recoveryState.nativeLive = false; };
  const config = { ...f.recoveryConfig, call: { ...f.recoveryConfig.call, maximumNativeRequests: 40 } };
  const recover = (connection = db) => recoverTwilioOutboundNotification(config, { ...f.recoveryPorts,
    call: { ...f.recoveryPorts.call, capacity: { matches: call.matches.bind(call), releaseOnce: async (ref, gate) => {
      f.recoveryState.beforeRelease?.(); return new PostgresOutboundCapacity(connection, scope, outboundCapacityOwnerBinding(a.campaignRef)!).releaseOnce(ref, gate);
    } } } }, f.recoveryInput, new AbortController().signal);
  if (scenario === "parallelCold") {
    const results = await Promise.all([recover(db), recover(peer)]); assert.equal(results.filter(r => r.ok && r.value.kind === "terminal" && r.value.released).length, 1);
    assert.ok(results.every(r => r.ok && r.value.kind === "terminal"));
  } else {
    const result = await recover();
    if (["accepted", "stored", "newSelections"].includes(scenario)) assert.deepEqual(value(result), { kind: "terminal", released: true });
    else assert.ok(!result.ok || result.value.kind === "held");
  }
  if (scenario === "newSelections") {
    const row = f.native.rows.get("30")!, observation = value(decodeTwilioOutboundTerminalObservation(row.notes)), context = value(f.runtime.authenticateStatus(f.request())).call.context;
    for (const change of ["key", "policy", "family"] as const) {
      const auth = change === "key" ? new TwilioOutboundTerminalObservationAuthentication(Buffer.alloc(32, 99), f.auth.binding()) : f.auth;
      const selected = { ...f.observations, ...(change === "policy" ? { terminalObservationPolicyDigest: "b".repeat(64) } : {}),
        ...(change === "family" ? { outboundTerminalObservationRecallTypeId: "67" } : {}) };
      const { authentication: _tag, ...unsigned } = observation;
      const signed = value(auth.sign(unsigned)), owner = twilioOutboundTerminalObservationRecordBinding(selected, auth)!;
      const records = value(ClinikoTwilioOutboundTerminalObservationRecords.create(selected, auth, { allows: async () => true, current: () => true, producerAdmitted: async () => true },
        new PostgresOutboundEffectBarrier(peer, scope, owner), f.native.port));
      assert.equal((await records.retainObservationOnce(signed, context, observation.accountSid, "2026-11-02", new AbortController().signal)).ok, false);
    }
  }
  const rows = (await sql<{ allocation_ref: string; released_at: Date | null }>`select allocation_ref,released_at from outbound_capacity_allocations where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(rows.length, 2); assert.equal(rows.find(r => r.allocation_ref === a.contactReferences!.allocationRef)!.released_at, null);
  assert.equal(rows.find(r => r.allocation_ref === a.capacityAllocationRef)!.released_at === null, ["unstored", "child", "sourceDenied", "withdrawnAtSql"].includes(scenario));
  const effects = (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(effects.length, 1); assert.equal(f.carrierRequests, 1); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
  await assertNotificationPrivacy(db, f, process.env.DATABASE_URL!);
});
