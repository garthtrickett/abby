import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outboundLaunchPeer } from "../support/outbound-one-shot-launch-peer.ts";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresOutboundEffectBarrier } from "../../src/storage/postgres-outbound-effect-barrier.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundLaunchOwnerFixture } from "../support/outbound-launch-owner.ts";
import { decodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoOutboundLaunchOwner } = await import(new URL("standalone/cliniko-outbound-launch-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const { OwnerFileOutboundCampaign } = await import(new URL("standalone/owner-file-outbound-campaign.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const { PostgresOutboundCapacity } = await import(new URL("storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
for (const scenario of ["accepted", "unknown", "lostNativeAck", "changedDnc", "concurrent", "acceptedThenWithdrawn"] as const)
test(`actual emitted follow-up launcher native180 PostgreSQL permanent effects and capacity: ${scenario}`, { timeout: 30_000 }, async t => {
  const apiKey = `synthetic-launch-${randomUUID()}-au5`, scope = { tenantId: `launch-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
  const f = await outboundLaunchOwnerFixture({ apiKey, scope, budget: new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 }),
    runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign }, effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b),
    capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) }); t.after(f.close);
  if (scenario === "unknown") f.controls.mode = "unknown";
  if (scenario === "lostNativeAck") f.controls.retainResponse = () => { throw new Error("Synthetic private native ACK lost"); };
  if (scenario === "changedDnc") f.controls.beforeEdge = async () => { f.state.live = false; };
  if (scenario === "acceptedThenWithdrawn") { f.controls.mode = "loseAfterAck"; f.controls.afterAck = async () => f.retire(); }
  const results = scenario === "concurrent" ? await Promise.all([f.launch(), value(f.make()).launchOnce(f.binding, new AbortController().signal)]) : [await f.launch()];
  if (scenario === "accepted" || scenario === "acceptedThenWithdrawn" || scenario === "concurrent") assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1);
  if (scenario === "unknown") assert.deepEqual(value(results[0]!), { kind: "unknown", capacity: "held" });
  if (scenario === "lostNativeAck") assert.equal(results[0]!.ok, false);
  const launched = scenario !== "lostNativeAck" && scenario !== "changedDnc";
  assert.equal(f.calls.length, launched ? 1 : 0); assert.equal(f.posts, 1);
  const rows = (await sql<{ allocation_ref: string; released_at: Date | null }>`select allocation_ref, released_at from outbound_capacity_allocations where tenant_id = ${scope.tenantId}`.execute(db)).rows;
  assert.equal(rows.filter(r => r.released_at === null).length, scenario === "lostNativeAck" ? 0 : 1);
  const effects = (await sql`select effect_ref from outbound_effect_barriers where tenant_id = ${scope.tenantId}
    and effect_ref in (${f.request.effectRef}::uuid, ${f.request.approvalRef}::uuid)`.execute(db)).rows;
  assert.equal(effects.length, 2); assert.ok(f.claims <= 150);
  // Cold owner still inspects native possible-history and cannot repeat even
  // if the local permanent effect rows were lost from a stale logical restore.
  if (scenario === "accepted" || scenario === "unknown") {
    await sql`delete from outbound_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db);
    assert.equal((await value(f.make()).launchOnce(f.binding, new AbortController().signal)).ok, false);
    assert.equal(f.calls.length, 1);
  }
  const canaries = [apiKey, f.request.recipient.number, "Abby possible outbound launch v1", "Abby possible outbound launch v2", "Abby outbound recipient request v1", "cliniko:recall:30", "generic-clinic-greeting"];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `launch_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
});

for (const hold of ["nativeAck", "provider"] as const)
test(`compiled launcher SIGKILL after ${hold} preserves actual SQL capacity/native history and cold no-replay`, { timeout: 30_000 }, async t => {
  const apiKey = `synthetic-worker-${randomUUID()}-au5`, scope = { tenantId: `launch-worker-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
  const f = await outboundLaunchOwnerFixture({ apiKey, scope, budget: new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 }),
    runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign }, effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b),
    capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) }); t.after(f.close);
  const directory = await mkdtemp(join(tmpdir(), "abby-one-shot-launch-empty-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let submitted!: () => void;
  const reached = new Promise<void>(resolve => { submitted = resolve; });
  const peer = await outboundLaunchPeer(f, directory, submitted, hold); t.after(peer.kill);
  await Promise.race([reached, peer.errors, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Synthetic held launch unavailable")), 20_000); t.after(() => clearTimeout(timer)); })]);
  assert.equal(f.posts, 1); assert.equal(f.calls.length, hold === "provider" ? 1 : 0);
  await peer.kill(); assert.deepEqual(peer.output, []); assert.deepEqual(await readdir(directory), []);
  const held = (await sql<{ allocation_ref: string }>`select allocation_ref from outbound_capacity_allocations where tenant_id = ${scope.tenantId} and released_at is null`.execute(db)).rows;
  assert.equal(held.length, 1, "process death is not proof a remote call ended");
  const durable = f.contactControls.rows.find(r => (r.recall_type as { links: { self: string } }).links.self.endsWith("/62"))!;
  assert.equal(value(decodeOutboundLaunchAttempt(durable.notes)).capacityAllocationRef, held[0]!.allocation_ref,
    "independent cold recovery has the exact native-to-allocation binding after owner death");
  await sql`delete from outbound_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db);
  // Closing/archiving the durable possible attempt cannot make it disappear.
  const attempt = f.contactControls.rows.find(r => (r.recall_type as { links: { self: string } }).links.self.endsWith("/62"))!;
  attempt.recalled = true; attempt.recalled_at = f.state.now; attempt.archived_at = f.state.now;
  assert.equal((await value(f.make()).launchOnce(f.binding, new AbortController().signal)).ok, false);
  assert.equal(f.calls.length, hold === "provider" ? 1 : 0); assert.equal(f.posts, 1);
  const values = [apiKey, f.request.recipient.number, "Abby possible outbound launch v1", "Abby possible outbound launch v2", "cliniko:recall:30"];
  assert.deepEqual(await scanPatientDataCanaries(db, values.map((value, i) => ({ label: `launch_worker_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const value of values) assert.equal(dump.includes(value), false);
});
