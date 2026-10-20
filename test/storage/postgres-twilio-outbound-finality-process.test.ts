// E2E-423: cold native recovery is qualified after both ordinary and queued-terminal stop preparation.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { outboundContactGuardOwnerBinding } from "../../src/core/outbound-capacity.ts";
import { assertOutboundFinalityPrivacy } from "../support/outbound-finality-privacy.ts";
import { twilioFinalityPeer } from "../support/twilio-outbound-finality-peer.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { twilioOutboundFinalityFixture } = await import(new URL("test/support/twilio-outbound-finality.js", emitted).href) as typeof import("../support/twilio-outbound-finality.ts");
const { PostgresOutboundCapacity } = await import(new URL("src/storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");

for (const queuedTerminal of [false, true])
test(`real emitted finality owner SIGKILL after ${queuedTerminal ? "queued terminal" : "ordinary"} stop and stored outcome needs no lost session/report IDs or private journal`, { timeout: 170000 }, async t => {
  const apiKey = `synthetic-finality-crash-${randomUUID()}-au5`, scope = { tenantId: `finality-crash-${randomUUID()}`, clinicId: "clinic", locationId: "main" }, guardRef = randomUUID();
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await twilioOutboundFinalityFixture({ apiKey, scope, budget, guardRef,
    patientId: (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString(),
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b),
    capacity: new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(guardRef)!) }); t.after(f.close);
  if (queuedTerminal) {
    const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
    const closed = once(wire.socket, "close"); wire.sendQueuedTail("socketClose"); await closed; await f.finished;
    f.state.now = "2026-11-02T00:00:03.000Z";
  } else await f.speakStop();
  const headroom = async () => { const until = Date.now() + 75000;
    while (await budget.checkHeadroom(100) !== null) { assert.ok(Date.now() < until, "wait only for actual native100 headroom"); await new Promise(resolve => setTimeout(resolve, 500)); } };
  await headroom();
  const cwd = await mkdtemp(join(tmpdir(), "abby-finality-empty-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  let stored!: () => void; const boundary = new Promise<void>(resolve => { stored = resolve; });
  const child = await twilioFinalityPeer(f, cwd, stored); t.after(child.kill);
  await Promise.race([boundary, child.errors, new Promise<never>((_, reject) => { const deadline = setTimeout(() => reject(Error("Synthetic finality outcome boundary not reached")), 20000); t.after(() => clearTimeout(deadline)); })]);
  await child.kill(); assert.deepEqual(child.output, []); assert.deepEqual(await readdir(cwd), []);
  const before = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(before.length, 2); assert.ok(before.every(h => h.released_at === null)); assert.equal(f.outcomePosts.length, 1);
  const immutableReport = f.reportPosts[0]!.notes;
  await headroom(); const recovered = value(await f.recoverFinality());
  assert.deepEqual(value(recovered.contact), { kind: "nativeContactOutcomeRetained", recallRef: "cliniko:recall:400", contactHold: "released" });
  assert.deepEqual(value(recovered.call), { kind: "terminal", released: true });
  const after = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.ok(after.every(h => h.released_at !== null)); assert.equal(f.reportPosts[0]!.notes, immutableReport);
  assert.equal(f.reportPosts.length, 1); assert.equal(f.outcomePosts.length, 1); assert.equal(f.dncPosts.length, 1); assert.equal(f.carrierCalls, 1);
  await assertOutboundFinalityPrivacy(db, f, process.env.DATABASE_URL!);
});
