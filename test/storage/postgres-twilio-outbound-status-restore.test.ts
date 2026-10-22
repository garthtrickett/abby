import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { assertStatusPrivacy } from "../support/outbound-status-privacy.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { twilioOutboundStatusVoiceFixture } = await import(new URL("test/support/twilio-outbound-status-voice.js", emitted).href) as typeof import("../support/twilio-outbound-status-voice.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresOutboundCapacity } = await import(new URL("src/storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { outboundContactGuardOwnerBinding } = await import(new URL("src/core/outbound-capacity.js", emitted).href) as typeof import("../../src/core/outbound-capacity.ts");
const { outboundDncRecordBinding } = await import(new URL("src/cliniko/outbound-dnc-records.js", emitted).href) as typeof import("../../src/cliniko/outbound-dnc-records.ts");
const { outboundStaffReviewRecordBinding } = await import(new URL("src/cliniko/outbound-staff-review-records.js", emitted).href) as typeof import("../../src/cliniko/outbound-staff-review-records.ts");
const { TwilioOutboundTerminalObservationAuthentication } = await import(new URL("src/cliniko/twilio-outbound-terminal-observation.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-terminal-observation.ts");
const { TwilioAbbyOutboundRuntime } = await import(new URL("src/voice/twilio-outbound-runtime.js", emitted).href) as typeof import("../../src/voice/twilio-outbound-runtime.ts");
const { TwilioOutboundReportAuthentication } = await import(new URL("src/cliniko/twilio-outbound-report.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-report.ts");
const { OwnerFileOutboundDncPolicy } = await import(new URL("src/standalone/owner-file-outbound-dnc-policy.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-dnc-policy.ts");
const { TwilioOutboundStatusDelivery } = await import(new URL("src/standalone/twilio-outbound-status-delivery.js", emitted).href) as typeof import("../../src/standalone/twilio-outbound-status-delivery.ts");

for (const staffReviewEnabled of [false, true])
test(`actual emitted signed callback full logical restore preserves ${staffReviewEnabled ? "unclear clinic review" : "positive STOP"} without another native write`, { timeout: 60000 }, async t => {
  const scope = { tenantId: `status-restore-${randomUUID()}`, clinicId: "clinic", locationId: "main" }, apiKey = `synthetic-status-restore-${randomUUID()}-au5`, guardRef = randomUUID();
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await twilioOutboundStatusVoiceFixture({ apiKey, scope, guardRef, budget,
    ...(staffReviewEnabled ? { staffReview: true, quality: "needsClarification" } : {}),
    patientId: (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString(),
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b),
    capacity: new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(guardRef)!) }); t.after(f.close);
  f.stateSpeech.decision = false;
  const voice = await f.listen(); t.after(voice.close); const wire = await f.start(voice), closed = once(wire.socket, "close");
  wire.sendTurn(); await closed; await f.finished; f.stateSpeech.decision = true;
  const callback = await f.listenStatus(); t.after(callback.close); assert.equal(await callback.send(), 204);
  assert.equal(f.reportPosts.length, staffReviewEnabled ? 0 : 1); assert.equal(f.dncPosts.length, staffReviewEnabled ? 0 : 1);
  assert.equal(f.notificationPosts.length, 1); assert.equal(f.staffPosts.length, staffReviewEnabled ? 1 : 0);
  const peer = connectPostgres(process.env.DATABASE_URL!); t.after(() => peer.destroy());
  const peerScope = { tenantId: `status-restore-peer-${randomUUID()}`, clinicId: "independent", locationId: "main" };
  const peerEffects = new PostgresOutboundEffectBarrier(peer, peerScope, "f".repeat(64));
  const peerCapacity = new PostgresOutboundCapacity(peer, peerScope, "f".repeat(64));
  const priorEffect = randomUUID(), priorHold = randomUUID(), laterEffect = randomUUID(), laterHold = randomUUID();
  assert.deepEqual(value(await peerEffects.claimOnce(priorEffect)), { claimed: true });
  assert.deepEqual(value(await peerCapacity.acquireOnce(priorHold, 2)), { kind: "acquired" });
  const { dump, originalEffects, originalHolds } = await db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
    // The complete expected tables and unfiltered export must describe one
    // snapshot, even while other test files add legitimate opaque state.
    const snapshot = (await sql<{ snapshot: string }>`select pg_export_snapshot() as snapshot`.execute(trx)).rows[0]!.snapshot;
    const originalEffects = await trx.selectFrom("outbound_effect_barriers").selectAll().orderBy("tenant_id").orderBy("effect_ref").execute();
    const originalHolds = await trx.selectFrom("outbound_capacity_allocations").selectAll().orderBy("tenant_id").orderBy("allocation_ref").execute();
    assert.ok(originalEffects.some(row => row.effect_ref === priorEffect));
    assert.ok(originalHolds.some(row => row.allocation_ref === priorHold));
    assert.deepEqual(value(await peerEffects.claimOnce(laterEffect)), { claimed: true });
    assert.deepEqual(value(await peerCapacity.acquireOnce(laterHold, 2)), { kind: "acquired" });
    assert.equal((await sql`select * from outbound_effect_barriers where effect_ref=${laterEffect}`.execute(peer)).rows.length, 1);
    assert.equal((await sql`select * from outbound_capacity_allocations where allocation_ref=${laterHold}`.execute(peer)).rows.length, 1);
    assert.equal(originalEffects.some(row => row.effect_ref === laterEffect), false);
    assert.equal(originalHolds.some(row => row.allocation_ref === laterHold), false);
    return { dump: await assertStatusPrivacy(db, f, process.env.DATABASE_URL!, snapshot), originalEffects, originalHolds };
  });
  const name = "abby_status_restore_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^abby_status_restore_[a-f0-9]{32}$/);
  await sql.raw(`create database "${name}"`).execute(db);
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/" + name;
  let restored: ReturnType<typeof connectPostgres> | undefined;
  try {
    execFileSync("psql", [url.href, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--quiet"], { input: dump, timeout: 10000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 8000000 });
    restored = connectPostgres(url.href);
    assert.deepEqual((await sql`select * from outbound_effect_barriers order by tenant_id,effect_ref`.execute(restored)).rows, originalEffects);
    assert.deepEqual((await sql`select * from outbound_capacity_allocations order by tenant_id,allocation_ref`.execute(restored)).rows, originalHolds);
    const freshBudget = new PostgresClinikoRequestBudget(restored, { apiKey, maxPerMinute: 180 }), clock = () => f.state.now;
    const runtime = new TwilioAbbyOutboundRuntime({ ...f.carrier, now: clock }, async () => { throw Error("Restored callback cannot launch a call"); });
    const selected = runtime.binding(), policy = value(await OwnerFileOutboundDncPolicy.capture({ path: f.policyPath, scope, directory: f.directory, clock }, new AbortController().signal));
    const prior = f.statusConfig, record = <T extends object>(config: T) => ({ ...config, clock, rateBudget: freshBudget });
    const dnc = { ...f.config.stop.dnc, source: record(f.config.stop.dnc.source) };
    const priorReview = prior.staffReview;
    const staffReview = priorReview && { config: { ...priorReview.config, observations: record(priorReview.config.observations),
      attempts: record(priorReview.config.attempts), reviews: record(priorReview.config.reviews) }, ports: { ...priorReview.ports,
      authentication: new TwilioOutboundTerminalObservationAuthentication(f.notificationKey, { ref: selected.ref, bindingDigest: selected.bindingDigest }),
      effects: new PostgresOutboundEffectBarrier(restored, scope, outboundStaffReviewRecordBinding(priorReview.config.reviews)!) } };
    const delivery = value(TwilioOutboundStatusDelivery.create({
      ...(staffReview ? { staffReview } : {}),
      notifications: { config: { ...prior.notifications.config, runtime, observations: record(prior.notifications.config.observations), attempts: record(prior.notifications.config.attempts) },
        ports: { ...prior.notifications.ports, effects: (s, b) => new PostgresOutboundEffectBarrier(restored!, s, b) } },
      stop: { config: { reports: record(f.reports), stop: { ...f.config.stop, requests: record(f.config.stop.requests), attempts: record(f.config.stop.attempts), dnc, policy } },
        ports: { ...prior.stop.ports, runtime, authentication: new TwilioOutboundReportAuthentication(f.key, { ref: selected.ref, bindingDigest: selected.bindingDigest }),
          effects: new PostgresOutboundEffectBarrier(restored, scope, outboundDncRecordBinding(dnc)!) } }, maximumNativeRequests: 180, deadlineMs: 5000 }));
    for (let n = 0; n < 2; n++) assert.deepEqual(value(await delivery.receiveStatus(f.statusRequest(), new AbortController().signal)), { kind: "acknowledged" });
    assert.equal(f.dncPosts.length, staffReviewEnabled ? 0 : 1); assert.equal(f.notificationPosts.length, 1);
    assert.equal(f.staffPosts.length, staffReviewEnabled ? 1 : 0); assert.equal(f.reportPosts.length, staffReviewEnabled ? 0 : 1); assert.equal(f.carrierCalls, 1);
    assert.deepEqual((await sql`select * from outbound_effect_barriers order by tenant_id,effect_ref`.execute(restored)).rows, originalEffects);
    assert.deepEqual((await sql`select * from outbound_capacity_allocations order by tenant_id,allocation_ref`.execute(restored)).rows, originalHolds);
    await assertStatusPrivacy(restored, f, url.href);
  } finally {
    await restored?.destroy(); await sql.raw(`drop database "${name}"`).execute(db);
  }
});
