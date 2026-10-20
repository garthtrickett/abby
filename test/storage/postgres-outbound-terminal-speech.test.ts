// E2E-423: bounded contact-only terminal public-ASR drain; complete no-stop and real acoustic acceptance remain open.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { once } from "node:events";
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
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresOutboundCapacity } = await import(new URL("src/storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");

for (const scenario of ["wireStop", "lateDecode", "socketClose", "queuedWireStop", "queuedSocketClose", "reportStored", "reportUnstored", "decisionGrant", "conversationGrant", "quota", "unclear"] as const)
test(`actual emitted unendpointed terminal speech retains native180, independent releases and SQL/raw-backup privacy: ${scenario}`, { timeout: 170000 }, async t => {
  const apiKey = `synthetic-terminal-${randomUUID()}-au5`, scope = { tenantId: `terminal-${randomUUID()}`, clinicId: "clinic", locationId: "main" }, guardRef = randomUUID();
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
  const f = await twilioOutboundFinalityFixture({ apiKey, scope, budget, patientId, guardRef,
    ...(scenario === "lateDecode" ? { transcriptionAt: "2026-11-02T00:00:04.000Z" } : {}),
    ...(scenario === "unclear" ? { quality: "needsClarification" } : {}),
    ...(scenario === "reportStored" ? { reportResponse: "lostStored" } : scenario === "reportUnstored" ? { reportResponse: "lostUnstored" } : {}),
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b),
    capacity: new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(guardRef)!) }); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  const queued = scenario === "queuedWireStop" || scenario === "queuedSocketClose";
  if (!queued) await wire.sendTail();
  assert.equal(f.transcriptionStats.flushes, 0);
  if (scenario === "decisionGrant") f.stateSpeech.decision = false;
  if (scenario === "conversationGrant") f.stateSpeech.conversation = false;
  if (scenario === "quota") {
    const competing = new PostgresClinikoRequestBudget(peer, { apiKey, maxPerMinute: 180 }); let claims = 0;
    while (await competing.claim() === null) assert.ok(++claims <= 180);
    assert.equal((await budget.claim())?.kind, "rateLimited");
  }
  const closed = once(wire.socket, "close");
  if (queued) wire.sendQueuedTail(scenario === "queuedWireStop" ? "wireStop" : "socketClose");
  else if (scenario === "wireStop") wire.stopTail(); else wire.socket.close();
  await closed; await f.finished; assert.deepEqual(f.intents, []); assert.deepEqual(f.acceptedTranscripts, []); assert.equal(f.spoken.length, 1);
  assert.equal(f.reportPosts.length, ["quota", "unclear", "conversationGrant"].includes(scenario) ? 0 : 1);
  assert.equal(f.dncPosts.length, ["reportUnstored", "decisionGrant", "quota", "unclear", "conversationGrant"].includes(scenario) ? 0 : 1);
  const holds = () => sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id=${scope.tenantId}`.execute(db);
  const before = (await holds()).rows; assert.equal(before.length, 2); assert.ok(before.every(h => h.released_at === null));
  const original = f.original();
  const effects = (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(effects.filter(e => e.effect_ref === original.sessionActionRef).length, 1);
  const second = await f.listen(); t.after(second.close); const answer = await second.post(); const duplicate = await second.open(await answer.text());
  assert.equal(await duplicate.outcome, "closed"); assert.equal(f.carrierCalls, 1); assert.equal(f.reportPosts.length <= 1, true);
  if (["wireStop", "lateDecode", "socketClose", "queuedWireStop", "queuedSocketClose", "reportStored"].includes(scenario)) {
    const until = Date.now() + 75000;
    while (await budget.checkHeadroom(100) !== null) { assert.ok(Date.now() < until, "wait only for real native100 headroom"); await new Promise(resolve => setTimeout(resolve, 500)); }
    f.state.now = scenario === "lateDecode" ? "2026-11-02T00:00:05.000Z" : "2026-11-02T00:00:03.000Z";
    const recovered = value(await f.recoverFinality()); assert.equal(value(recovered.contact).kind, "nativeContactOutcomeRetained");
    assert.deepEqual(value(recovered.call), { kind: "terminal", released: true });
    assert.ok((await holds()).rows.every(h => h.released_at !== null)); assert.equal(f.outcomePosts.length, 1);
    assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, 1);
  } else assert.equal(f.outcomePosts.length, 0);
  await assertOutboundFinalityPrivacy(db, f, process.env.DATABASE_URL!);
});
