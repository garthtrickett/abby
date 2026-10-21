import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { twilioStatusPeer } from "../support/twilio-outbound-status-peer.ts";
import { assertStatusPrivacy } from "../support/outbound-status-privacy.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { twilioOutboundStatusVoiceFixture } = await import(new URL("test/support/twilio-outbound-status-voice.js", emitted).href) as typeof import("../support/twilio-outbound-status-voice.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresOutboundCapacity } = await import(new URL("src/storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { outboundContactGuardOwnerBinding } = await import(new URL("src/core/outbound-capacity.js", emitted).href) as typeof import("../../src/core/outbound-capacity.ts");
const { twilioOutboundTerminalActionRef } = await import(new URL("src/cliniko/twilio-outbound-terminal-observation.js", emitted).href) as typeof import("../../src/cliniko/twilio-outbound-terminal-observation.ts");

for (const family of ["91", "66"] as const) for (const stored of [false, true])
test(`emitted signed HTTP callback SIGKILL ${stored ? "after" : "before"} native ${family} storage recovers only independently retained truth`, { timeout: 60000 }, async t => {
  const scope = { tenantId: `status-crash-${randomUUID()}`, clinicId: "clinic", locationId: "main" }, apiKey = `synthetic-status-crash-${randomUUID()}-au5`, guardRef = randomUUID();
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await twilioOutboundStatusVoiceFixture({ apiKey, scope, guardRef, budget,
    patientId: (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString(),
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b),
    capacity: new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(guardRef)!) }); t.after(f.close);
  f.stateSpeech.decision = false;
  const voice = await f.listen(); t.after(voice.close); const wire = await f.start(voice), closed = once(wire.socket, "close");
  wire.sendTurn(); await closed; await f.finished; f.stateSpeech.decision = true;
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, 0); assert.equal(f.notificationPosts.length, 0);
  const cwd = await mkdtemp(join(tmpdir(), "abby-status-empty-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  let reached!: () => void; const boundary = new Promise<void>(resolve => { reached = resolve; });
  const peer = await twilioStatusPeer(f, cwd, { family, stored, reached }); t.after(peer.kill);
  const interrupted = peer.send().then(() => { throw Error("The killed HTTP request unexpectedly completed"); }, () => undefined);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Native callback boundary not reached")), 15000); });
  try { await Promise.race([boundary, peer.errors, timeout]); } finally { clearTimeout(timer!); }
  const purposes = async () => (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(db)).rows.map(r => r.effect_ref).sort();
  const before = await purposes(), dncAction = f.attempt.dncReferences!.actionRef, notificationAction = twilioOutboundTerminalActionRef(f.original().sessionActionRef)!;
  assert.ok(before.includes(dncAction)); assert.equal(before.includes(notificationAction), family === "66");
  assert.equal(f.dncPosts.length, family === "91" ? Number(stored) : 1); assert.equal(f.notificationPosts.length, family === "66" ? Number(stored) : 0);
  await peer.kill(); await interrupted; assert.deepEqual(peer.output, []); assert.deepEqual(await readdir(cwd), []);
  const fresh = await twilioStatusPeer(f, cwd); t.after(fresh.kill);
  assert.equal(await fresh.send(), stored ? 204 : 503); assert.equal(await fresh.send(), stored ? 204 : 503); await fresh.close();
  assert.deepEqual(fresh.output, []); assert.deepEqual(await readdir(cwd), []);
  assert.equal(f.dncPosts.length, family === "91" ? Number(stored) : 1);
  assert.equal(f.notificationPosts.length, stored ? 1 : 0); assert.equal(f.reportPosts.length, 1); assert.equal(f.carrierCalls, 1);
  const after = await purposes(); assert.equal(after.filter(r => r === dncAction).length, 1);
  assert.equal(after.filter(r => r === notificationAction).length, family === "66" || stored ? 1 : 0);
  const holds = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(holds.length, 2); assert.ok(holds.every(h => h.released_at === null));
  await assertStatusPrivacy(db, f, process.env.DATABASE_URL!);
});
