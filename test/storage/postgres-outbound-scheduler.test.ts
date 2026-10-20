import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { outboundCapacityOwnerBinding } from "../../src/core/outbound-capacity.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundSchedulerFixture } from "../support/outbound-scheduler.ts";
import { outboundLaunchPeer } from "../support/outbound-one-shot-launch-peer.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoOutboundScheduler } = await import(new URL("standalone/cliniko-outbound-scheduler.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-scheduler.ts");
const { ClinikoOutboundLaunchHistory } = await import(new URL("cliniko/outbound-launch-history.js", emitted).href) as typeof import("../../src/cliniko/outbound-launch-history.ts");
const { ClinikoOutboundLaunchOwner } = await import(new URL("standalone/cliniko-outbound-launch-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const { OwnerFileOutboundCampaign } = await import(new URL("standalone/owner-file-outbound-campaign.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const { PostgresOutboundCapacity } = await import(new URL("storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
async function fixture() {
  const apiKey = `synthetic-scheduler-${randomUUID()}-au5`, scope = { tenantId: `schedule-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await outboundSchedulerFixture({ apiKey, scope, budget, Scheduler: ClinikoOutboundScheduler,
    runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign }, effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b),
    capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) });
  return { ...f, get claims() { return f.claims; }, get posts() { return f.posts; }, apiKey, physicalBudget: budget, scope };
}
async function privacy(f: Awaited<ReturnType<typeof fixture>>) {
  const values = [f.apiKey, f.request.recipient.number, "Abby possible outbound launch v2", "Abby possible outbound launch v3", "cliniko:recall:30", "generic-clinic-greeting"];
  assert.deepEqual(await scanPatientDataCanaries(db, values.map((value, i) => ({ label: `scheduler_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const value of values) assert.equal(dump.includes(value), false);
}
for (const scenario of ["accepted", "unknown", "denied", "lateSchedule", "capacity"] as const)
  test(`actual emitted finite scheduler native180 SQL and backup privacy: ${scenario}`, { timeout: 30_000 }, async t => {
    const f = await fixture(); t.after(f.close);
    if (scenario === "unknown") f.controls.mode = "unknown";
    if (scenario === "denied") f.scheduleState.schedule = false;
    if (scenario === "lateSchedule") f.controls.beforeEdge = () => { f.scheduleState.schedule = false; };
    if (scenario === "capacity") value(await new PostgresOutboundCapacity(db, f.scope, outboundCapacityOwnerBinding(f.request.campaignRef)!).acquireOnce(randomUUID(), 1));
    const result = await f.tick();
    assert.equal(result.accepted, scenario === "accepted" ? 1 : 0); assert.equal(result.unknown, scenario === "unknown" ? 1 : 0);
    if (scenario === "denied") assert.equal(result.kind, "blocked");
    if (scenario === "capacity") assert.equal(result.kind, "capacityWaiting");
    assert.equal(f.calls.length, ["accepted", "unknown"].includes(scenario) ? 1 : 0);
    assert.equal(f.posts, ["accepted", "unknown", "lateSchedule"].includes(scenario) ? 1 : 0); assert.ok(f.claims <= 180);
    const rows = (await sql`select allocation_ref from outbound_capacity_allocations where tenant_id = ${f.scope.tenantId} and released_at is null`.execute(db)).rows;
    assert.equal(rows.length, scenario === "denied" ? 0 : 1);
    await privacy(f);
  });
test("compiled scheduler waits on a real SQL physical quota window before fresh native launch preparation", { timeout: 125_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  for (let n = 0; n < 100; n++) assert.equal(await f.physicalBudget.claim(), null);
  const wait = f.schedulerPorts.waitForQuota, began = performance.now();
  f.schedulerPorts.waitForQuota = async (ms, signal) => {
    await delay(ms, undefined, { signal });
    await wait(ms, signal);
  };
  const result = await f.makeScheduler().tick(new AbortController().signal);
  assert.equal(result.accepted, 1); assert.equal(f.calls.length, 1); assert.equal(f.posts, 1);
  assert.equal(f.scheduleState.waits, 1); assert.ok(performance.now() - began >= 55_000, "real account cooldown elapsed; no quota row was edited/reset");
  assert.ok(f.claims <= 180); await privacy(f);
});
test("compiled cold scheduler after SIGKILL and real quota recovery reads archived native history after local exclusion loss", { timeout: 125_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const cwd = await mkdtemp(join(tmpdir(), "abby-scheduler-cold-empty-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  let sent!: () => void; const reached = new Promise<void>(resolve => { sent = resolve; });
  const peer = await outboundLaunchPeer(f, cwd, sent, "provider"); t.after(peer.kill);
  await Promise.race([reached, peer.errors, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Synthetic held scheduler call unavailable")), 20_000); t.after(() => clearTimeout(timer)); })]);
  await peer.kill(); assert.equal(f.calls.length, 1); assert.equal(f.posts, 1); assert.deepEqual(peer.output, []); assert.deepEqual(await readdir(cwd), []);
  const attempt = f.contactControls.rows.find(r => (r.recall_type as { links: { self: string } }).links.self.endsWith("/62"))!;
  attempt.recalled = true; attempt.recalled_at = f.state.now; attempt.archived_at = f.state.now;
  await sql`delete from outbound_effect_barriers where tenant_id = ${f.scope.tenantId}`.execute(db);
  const began = performance.now(), oldNow = Date.parse(f.state.now), deadline = began + 85_000;
  while (await f.physicalBudget.checkHeadroom(180) !== null) {
    assert.ok(performance.now() < deadline, "the real SQL window must recover under the unchanged180 budget");
    await delay(250);
  }
  f.state.now = new Date(oldNow + Math.ceil(performance.now() - began)).toISOString();
  let archivedReads = 0;
  f.contactControls.get = row => { if (row.id === attempt.id) archivedReads++; return Response.json(row); };
  const history = value(ClinikoOutboundLaunchHistory.create(f.config.attempts, f.ports.history, f.schedulerPorts.launch.native));
  const observed = value(await history.readForRequest({ recallRef: f.binding.recallRef, request: f.request }, new AbortController().signal));
  assert.equal(observed.records.length, 1); assert.equal(observed.records[0]!.recalled, true);
  assert.notEqual(observed.records[0]!.archivedAt, null);
  archivedReads = 0;
  const result = await f.makeScheduler().tick(new AbortController().signal);
  assert.equal(result.alreadyAttempted, 1); assert.equal(result.accepted, 0); assert.equal(result.unknown, 0);
  assert.ok(archivedReads > 0, "actual native history, not a quota/capacity denial, prevents cold replay");
  assert.equal(f.calls.length, 1); assert.equal(f.posts, 1);
  assert.equal((await sql`select effect_ref from outbound_effect_barriers where tenant_id = ${f.scope.tenantId}`.execute(db)).rows.length, 0);
  await privacy(f);
});
