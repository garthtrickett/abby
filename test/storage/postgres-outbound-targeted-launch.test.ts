import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundTargetedLaunchFixture } from "../support/outbound-targeted-launch.ts";
import { outboundLaunchPeer } from "../support/outbound-one-shot-launch-peer.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoOutboundLaunchOwner } = await import(new URL("standalone/cliniko-outbound-launch-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const { OwnerFileOutboundCampaign } = await import(new URL("standalone/owner-file-outbound-campaign.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const { PostgresOutboundCapacity } = await import(new URL("storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
async function fixture() {
  const apiKey = `synthetic-targeted-${randomUUID()}-au5`, scope = { tenantId: `targeted-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await outboundTargetedLaunchFixture({ apiKey, scope, budget, runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign },
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) });
  return { ...f, get posts() { return f.posts; }, get claims() { return f.claims; }, apiKey, scope, physicalBudget: budget };
}
async function privacy(f: Awaited<ReturnType<typeof fixture>>) {
  const canaries = [f.apiKey, f.request.recipient.number, "cliniko:appointment:71", "cliniko:recall:30", "discard-private-native-target-note", "discard-private-native-target-name"];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `targeted_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  for (const canary of [...canaries, f.requestRow.notes]) assert.equal(dump.includes(canary), false);
}
for (const scenario of ["accepted", "unknown", "lateTarget", "lateGrant", "grantDrift", "missingComposition", "quota", "ackGrantWithdrawal", "concurrent"] as const)
  test(`emitted exact sick-day launch native180 permanent SQL and privacy: ${scenario}`, { timeout: 30000 }, async t => {
    const f = await fixture(); t.after(f.close);
    if (scenario === "unknown") f.controls.mode = "unknown";
    if (scenario === "lateTarget") f.controls.beforeEdge = () => { f.targetRow.updated_at = "2026-10-02T00:00:00.000002Z"; };
    if (scenario === "lateGrant") f.controls.beforeEdge = () => { f.targetState.live = false; };
    if (scenario === "grantDrift") f.targetState.launchAllows = q => { if (q.operation === "approveAppointmentTarget") f.targetRow.updated_at = "2026-10-02T00:00:00.000002Z"; return true; };
    if (scenario === "ackGrantWithdrawal") { f.controls.mode = "loseAfterAck"; f.controls.afterAck = () => { f.targetState.live = false; }; }
    if (scenario === "quota") for (let i = 0; i < 180; i++) if (await f.physicalBudget.claim() !== null) break;
    const results = scenario === "concurrent" ? await Promise.all([f.launchTargeted(), value(f.makeTargeted()).launchOnce(f.binding, new AbortController().signal)])
      : [await (scenario === "missingComposition" ? f.launch() : f.launchTargeted())];
    const accepted = ["accepted", "ackGrantWithdrawal", "concurrent"].includes(scenario), queued = accepted || scenario === "unknown";
    if (accepted) assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1);
    else if (scenario === "unknown") assert.equal(value(results[0]!).kind, "unknown"); else assert.equal(results[0]!.ok, false);
    assert.equal(f.calls.length, queued ? 1 : 0);
    const possible = queued || scenario === "lateTarget" || scenario === "lateGrant";
    assert.equal(f.posts, possible ? 1 : 0);
    const rows = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id = ${f.scope.tenantId}`.execute(db)).rows;
    assert.equal(rows.filter(r => r.released_at === null).length, possible ? 1 : 0);
    const effects = (await sql`select effect_ref from outbound_effect_barriers where tenant_id = ${f.scope.tenantId}
      and effect_ref in (${f.request.effectRef}::uuid, ${f.request.approvalRef}::uuid)`.execute(db)).rows;
    assert.equal(effects.length, possible ? 2 : 0);
    if (scenario === "accepted" || scenario === "unknown") {
      assert.equal((await value(f.makeTargeted()).launchOnce(f.binding, new AbortController().signal)).ok, false); assert.equal(f.calls.length, 1);
    }
    assert.ok(f.claims <= 150); await privacy(f);
  });
for (const hold of ["nativeAck", "provider"] as const)
  test(`emitted sick-day owner SIGKILL after ${hold} recovers complete archived native history after local row loss`, { timeout: 125000 }, async t => {
    const f = await fixture(); t.after(f.close);
    const directory = await mkdtemp(join(tmpdir(), "abby-targeted-launch-empty-")); t.after(() => rm(directory, { recursive: true, force: true }));
    let submitted!: () => void; const reached = new Promise<void>(resolve => { submitted = resolve; });
    const peer = await outboundLaunchPeer(f, directory, submitted, hold, { individualTarget: f.targetConfig.individualTarget,
      target: f.targetPorts.target, authority: f.targetPorts.authority, native: f.targetPorts.native }); t.after(peer.kill);
    await Promise.race([reached, peer.errors, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error("Synthetic targeted owner not held")), 20000); t.after(() => clearTimeout(timer)); })]);
    assert.equal(f.posts, 1); assert.equal(f.calls.length, hold === "provider" ? 1 : 0); await peer.kill();
    assert.deepEqual(peer.output, []); assert.deepEqual(await readdir(directory), []);
    const native = f.contactControls.rows.find(r => (r.recall_type as { links: { self: string } }).links.self.endsWith("/62")); assert.ok(native);
    native.recalled = true; native.recalled_at = f.state.now; native.archived_at = f.state.now; native.updated_at = f.state.now;
    await sql`delete from outbound_effect_barriers where tenant_id = ${f.scope.tenantId}`.execute(db);
    // Wait for real physical native180 headroom. Quota or full capacity must not
    // mask the claimed independent archived-history recovery proof.
    const deadline = Date.now() + 75000;
    while (await f.physicalBudget.checkHeadroom(150) !== null) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 500)); }
    let archivedReads = 0; f.contactControls.get = row => { if (row.id === native.id) archivedReads++; return Response.json(row); };
    assert.deepEqual(await value(f.makeTargeted()).launchOnce(f.binding, new AbortController().signal), { ok: false, error: { kind: "alreadyAttempted" } });
    assert.ok(archivedReads > 0); assert.equal(f.posts, 1); assert.equal(f.calls.length, hold === "provider" ? 1 : 0);
    const rows = (await sql`select allocation_ref from outbound_capacity_allocations where tenant_id = ${f.scope.tenantId} and released_at is null`.execute(db)).rows;
    assert.equal(rows.length, 1); await privacy(f);
  });
