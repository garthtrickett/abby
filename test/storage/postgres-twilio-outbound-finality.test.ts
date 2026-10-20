import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { outboundContactGuardOwnerBinding } from "../../src/core/outbound-capacity.ts";
import { assertOutboundFinalityPrivacy } from "../support/outbound-finality-privacy.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL), peer = connectPostgres(process.env.DATABASE_URL);
after(async () => { await Promise.all([db.destroy(), peer.destroy()]); });
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { twilioOutboundFinalityFixture } = await import(new URL("test/support/twilio-outbound-finality.js", emitted).href) as typeof import("../support/twilio-outbound-finality.ts");
const { PostgresOutboundCapacity } = await import(new URL("src/storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { recoverTwilioOutboundFinality } = await import(new URL("src/standalone/cliniko-twilio-outbound-finality-recovery.js", emitted).href) as typeof import("../../src/standalone/cliniko-twilio-outbound-finality-recovery.ts");
const { outboundDncRecordBinding } = await import(new URL("src/cliniko/outbound-dnc-records.js", emitted).href) as typeof import("../../src/cliniko/outbound-dnc-records.ts");
const { outboundContactOutcomeRecordBinding } = await import(new URL("src/cliniko/outbound-contact-outcome-records.js", emitted).href) as typeof import("../../src/cliniko/outbound-contact-outcome-records.ts");
const { outboundCapacityOwnerBinding } = await import(new URL("src/core/outbound-capacity.js", emitted).href) as typeof import("../../src/core/outbound-capacity.ts");
const { decodeOutboundContactOutcome } = await import(new URL("src/cliniko/outbound-contact-outcome.js", emitted).href) as typeof import("../../src/cliniko/outbound-contact-outcome.ts");

for (const scenario of ["accepted", "sourceDenied", "child", "outcomeStored", "outcomeUnstored", "callRelease", "contactRelease", "parallelCold", "unclear"] as const)
test(`emitted actual signed positive finality releases only independently proven SQL holds: ${scenario}`, { timeout: 170000 }, async t => {
  const apiKey = `synthetic-finality-${randomUUID()}-au5`, scope = { tenantId: `finality-${randomUUID()}`, clinicId: "clinic", locationId: "main" }, guardRef = randomUUID();
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
  const f = await twilioOutboundFinalityFixture({ apiKey, scope, budget, patientId, guardRef, ...(scenario === "unclear" ? { quality: "needsClarification" } : {}),
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b),
    capacity: new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(guardRef)!) }); t.after(f.close);
  await f.speakStop(); const original = f.original();
  if (scenario === "sourceDenied") f.finalityState.source = false;
  if (scenario === "child") f.finalityState.child = true;
  if (scenario === "callRelease") f.finalityState.callRelease = false;
  if (scenario === "contactRelease") f.finalityState.contactRelease = false;
  if (scenario === "outcomeStored") f.finalityState.outcomeResponse = "lostStored";
  if (scenario === "outcomeUnstored") f.finalityState.outcomeResponse = "lostUnstored";
  const headroom = async () => { const until = Date.now() + 75000;
    while (await budget.checkHeadroom(100) !== null) { assert.ok(Date.now() < until, "wait only for actual native100 headroom"); await new Promise(resolve => setTimeout(resolve, 500)); } };
  const recover = async (connection = db) => {
    const before = f.finalityNativeCalls;
    const ports = { ...f.finalityPorts, contact: { ...f.finalityPorts.contact,
      stop: { ...f.finalityPorts.contact.stop, effects: new PostgresOutboundEffectBarrier(connection, scope, outboundDncRecordBinding(f.config.stop.dnc)!) },
      outcomeEffects: new PostgresOutboundEffectBarrier(connection, scope, outboundContactOutcomeRecordBinding(f.finalityConfig.contact.outcomes)!),
      capacity: new PostgresOutboundCapacity(connection, scope, outboundContactGuardOwnerBinding(guardRef)!) },
      call: { ...f.finalityPorts.call, capacity: new PostgresOutboundCapacity(connection, scope, outboundCapacityOwnerBinding(f.attempt.campaignRef)!) } };
    const result = await recoverTwilioOutboundFinality(f.finalityConfig, ports, { recallRef: original.original.recallRef, actionRef: f.attempt.actionRef, patientId }, new AbortController().signal);
    // Parallel invocations count aggregate dispatches in the fixture. Their
    // shared real physical180 budget independently enforces aggregate admission.
    if (scenario !== "parallelCold") assert.ok(f.finalityNativeCalls - before <= 180);
    return result;
  };
  await headroom();
  if (scenario === "parallelCold") {
    await Promise.all([recover(db), recover(peer)]); await headroom(); value(await recover(peer));
  } else {
    const first = value(await recover());
    if (scenario === "accepted") { assert.equal(value(first.contact).kind, "nativeContactOutcomeRetained"); assert.equal(value(first.call).kind, "terminal"); }
    if (scenario === "outcomeStored" || scenario === "outcomeUnstored") {
      assert.equal(value(first.contact).kind, "held"); f.finalityState.outcomeResponse = "ack"; await headroom(); value(await recover(peer));
    }
  }
  const holds = (await sql<{ allocation_ref: string; released_at: Date | null }>`select allocation_ref,released_at from outbound_capacity_allocations where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(holds.length, 2);
  const contact = holds.find(h => h.allocation_ref === f.attempt.contactReferences!.allocationRef)!, call = holds.find(h => h.allocation_ref === f.attempt.capacityAllocationRef)!;
  assert.equal(contact.released_at === null, ["sourceDenied", "child", "outcomeUnstored", "contactRelease", "unclear"].includes(scenario));
  assert.equal(call.released_at === null, ["sourceDenied", "child", "callRelease", "unclear"].includes(scenario));
  assert.equal(f.outcomePosts.length, ["sourceDenied", "child", "unclear"].includes(scenario) ? 0 : 1);
  assert.equal(f.reportPosts.length, scenario === "unclear" ? 0 : 1); assert.equal(f.dncPosts.length, scenario === "unclear" ? 0 : 1); assert.equal(f.carrierCalls, 1); assert.deepEqual(f.intents, []);
  if (f.outcomePosts.length) assert.equal(value(decodeOutboundContactOutcome(f.outcomePosts[0]!.notes)).actionRef, f.attempt.contactReferences!.outcomeActionRef);
  const effects = (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(effects.filter(e => e.effect_ref === f.attempt.contactReferences!.outcomeActionRef).length, f.outcomePosts.length);
  await assertOutboundFinalityPrivacy(db, f, process.env.DATABASE_URL!);
});
