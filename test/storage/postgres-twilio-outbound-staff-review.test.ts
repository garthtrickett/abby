import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { assertStatusPrivacy } from "../support/outbound-status-privacy.ts";
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
const { outboundStaffReviewActionRef, decodeOutboundStaffReviewRequest } = await import(new URL("src/cliniko/outbound-staff-review-request.js", emitted).href) as typeof import("../../src/cliniko/outbound-staff-review-request.ts");
const { twilioOutboundTerminalActionRef } = await import(new URL("src/cliniko/twilio-outbound-terminal-observation.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-terminal-observation.ts");

for (const scenario of ["unclear", "stored", "unstored", "permission", "source", "signature", "quota", "parallel", "positiveStop", "notificationStored"] as const)
test(`emitted unclear-call clinic review uses signed HTTP, native provenance and SQL exclusion without releasing contact: ${scenario}`, { timeout: 60000 }, async t => {
  const apiKey = `synthetic-staff-review-${randomUUID()}-au5`, scope = { tenantId: `staff-review-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
  const guardRef = randomUUID(), budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await twilioOutboundStatusVoiceFixture({ apiKey, scope, patientId, guardRef, budget,
    staffReview: true, text: "Please remove my number from your calling list.", quality: scenario === "positiveStop" ? "clear" : "needsClarification",
    ...(scenario === "stored" ? { staffReviewResponse: "lostStored" } : scenario === "unstored" ? { staffReviewResponse: "lostUnstored" } : {}),
    ...(scenario === "notificationStored" ? { notificationResponse: "lostStored" } : {}),
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b),
    capacity: new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(guardRef)!) });
  t.after(f.close);
  // The real media/ASR producer sees this unclear turn. No ready-made report or
  // negative contact decision is injected to make the callback succeed.
  f.stateSpeech.decision = false;
  const voice = await f.listen(); t.after(voice.close);
  const wire = await f.start(voice), closed = once(wire.socket, "close");
  wire.sendTurn(); await closed; await f.finished;
  assert.equal(f.transcriptionStats.flushes, 1); assert.equal(f.reportPosts.length, scenario === "positiveStop" ? 1 : 0);
  assert.equal(f.dncPosts.length, 0); assert.equal(f.staffPosts.length, 0); assert.equal(f.carrierCalls, 1); assert.deepEqual(f.intents, []);
  f.stateSpeech.decision = true;
  if (scenario === "permission" || scenario === "positiveStop") f.staffState.producer = false;
  if (scenario === "source") f.notificationState.source = false;
  if (scenario === "quota") for (let n = 0; n < 180; n++) if (await budget.claim() !== null) break;
  let callback = await f.listenStatus(); t.after(() => callback.close());
  if (scenario === "signature") {
    assert.equal(await callback.send({ ...f.statusRequest(), signature: "forged" }), 403);
    assert.equal(await callback.send(f.statusRequest({ CallStatus: "ringing" })), 204);
    assert.equal(f.notificationPosts.length, 0); assert.equal(f.staffPosts.length, 0);
    assert.equal(await callback.send(), 204);
  } else if (scenario === "parallel") {
    const results = await Promise.all([callback.send(), callback.send()]);
    assert.ok(results.includes(204)); assert.ok(results.every(status => status === 204 || status === 503));
    assert.equal(await callback.send(), 204);
  } else {
    assert.equal(await callback.send(), ["stored", "unstored", "permission", "source", "quota"].includes(scenario) ? 503 : 204);
    if (scenario === "permission" || scenario === "source") {
      assert.equal(f.staffPosts.length, 0); f.staffState.producer = true; f.notificationState.source = true;
    }
    // Construct a fresh HTTP receiver/delivery owner. Durable native history and
    // PostgreSQL purpose ownership, rather than an in-process cache, recover it.
    await callback.close(); callback = await f.listenStatus();
    assert.equal(await callback.send(), ["unstored", "quota"].includes(scenario) ? 503 : 204);
  }
  const expectedReviewPosts = scenario === "quota" || scenario === "positiveStop" ? 0 : 1;
  assert.equal(f.staffPosts.length, expectedReviewPosts); assert.equal(f.notificationPosts.length, scenario === "quota" ? 0 : 1);
  assert.equal(f.dncPosts.length, scenario === "positiveStop" ? 1 : 0);
  if (expectedReviewPosts) {
    const request = value(decodeOutboundStaffReviewRequest(f.staffPosts[0]!.notes));
    assert.equal(request.state, "needsClinicReview"); assert.equal(request.reason, "contactCoverageUnresolved");
    assert.equal(request.attempt.actionRef, f.attempt.actionRef); assert.equal(request.actionRef, outboundStaffReviewActionRef(f.attempt.actionRef));
    assert.equal(Object.hasOwn(request, "number"), false); assert.equal(Object.hasOwn(request, "contact"), false);
    const retained = f.contactControls.rows.filter(row => (row.recall_type as { links: { self: string } }).links.self.endsWith("/75"));
    assert.equal(retained.length, scenario === "unstored" ? 0 : 1);
  }
  const effects = (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(db)).rows;
  const original = f.original();
  assert.equal(effects.filter(row => row.effect_ref === original.sessionActionRef).length, 1);
  assert.equal(effects.filter(row => row.effect_ref === twilioOutboundTerminalActionRef(original.sessionActionRef)).length, f.notificationPosts.length);
  assert.equal(effects.filter(row => row.effect_ref === outboundStaffReviewActionRef(f.attempt.actionRef)).length, expectedReviewPosts);
  assert.equal(effects.filter(row => row.effect_ref === f.attempt.dncReferences!.actionRef).length, f.dncPosts.length);
  const holds = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(holds.length, 2); assert.ok(holds.every(row => row.released_at === null)); assert.equal(f.carrierCalls, 1);
  await assertStatusPrivacy(db, f, process.env.DATABASE_URL!);
});
