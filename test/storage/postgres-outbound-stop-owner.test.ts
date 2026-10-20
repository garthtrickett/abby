import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundStopOwnerFixture } from "../support/outbound-stop-owner.ts";
import { value } from "../support/outbound-records.ts";
import { encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoOutboundStopOwner } = await import(new URL("standalone/cliniko-outbound-stop-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-stop-owner.ts");
const { OwnerFileOutboundDncPolicy } = await import(new URL("standalone/owner-file-outbound-dnc-policy.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-dnc-policy.ts");
const { ClinikoOutboundLaunchOwner } = await import(new URL("standalone/cliniko-outbound-launch-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const { OwnerFileOutboundCampaign } = await import(new URL("standalone/owner-file-outbound-campaign.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const { PostgresOutboundCapacity } = await import(new URL("storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
for (const scenario of ["accepted", "lostAck", "unstored", "concurrent", "closed", "lineageDenied", "policyDisabled", "legacy", "quota"] as const)
  test(`emitted native stop owner native180 opaque SQL and full backup privacy: ${scenario}`, { timeout: 30000 }, async t => {
    const apiKey = `synthetic-stop-${randomUUID()}-au5`, scope = { tenantId: `stop-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
    const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
    const f = await outboundStopOwnerFixture({ apiKey, scope, budget, StopOwner: ClinikoOutboundStopOwner, Policy: OwnerFileOutboundDncPolicy,
      runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign }, effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b),
      capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) }); t.after(f.close);
    if (scenario === "lostAck") f.stopState.response = () => { throw Error("Synthetic native acknowledgement lost"); };
    if (scenario === "unstored") f.stopState.beforeStore = () => { throw Error("Synthetic native dispatch not observed"); };
    if (scenario === "closed") for (const row of [f.row, f.requestRow]) {
      row.recalled = true; row.recalled_at = f.state.now; row.archived_at = f.state.now; row.updated_at = f.state.now;
    }
    if (scenario === "lineageDenied") f.contactControls.allow = q => q.operation !== "readContactLineage";
    if (scenario === "policyDisabled") await f.replaceStopPolicy({ enabled: false });
    if (scenario === "legacy") { const { dncReferences: _refs, ...legacy } = f.attempt; f.row.notes = value(encodeOutboundLaunchAttempt(legacy)); }
    if (scenario === "quota") for (let n = 0; n < 180; n++) if (await budget.claim() !== null) break;
    let result: Awaited<ReturnType<typeof f.retainStop>>;
    if (scenario === "concurrent") {
      const a = value(f.makeStop()), b = value(f.makeStop()), signal = new AbortController().signal;
      const results = await Promise.all([a.retainStopOnce(f.stopBinding, signal), b.retainStopOnce(f.stopBinding, signal)]);
      const accepted = results.filter(r => r.ok && r.value.kind === "accepted"); assert.equal(accepted.length, 1); result = accepted[0]!;
    } else result = await f.retainStop();
    if (["lineageDenied", "policyDisabled", "legacy", "quota"].includes(scenario)) { assert.equal(result.ok, false); assert.equal(f.dncPosts.length, 0); }
    else {
      assert.equal(value(result).kind, scenario === "lostAck" || scenario === "unstored" ? "uncertain" : "accepted"); assert.equal(f.dncPosts.length, 1);
      const cold = value(f.makeStop()), repeated = await cold.retainStopOnce(f.stopBinding, new AbortController().signal);
      if (scenario === "unstored") assert.equal(repeated.ok, false);
      else assert.equal(value(repeated).kind, "existingDecision");
      assert.equal(f.dncPosts.length, 1);
    }
    const effects = (await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db)).rows;
    assert.equal(effects.filter(r => r.effect_ref === f.attempt.dncReferences?.actionRef).length, f.dncPosts.length ? 1 : 0);
    assert.equal(effects.some(r => r.effect_ref === f.attempt.dncReferences?.approvalRef), false);
    const allocations = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id = ${scope.tenantId}`.execute(db)).rows;
    assert.equal(allocations.length, 1); assert.equal(allocations[0]!.released_at, null); assert.equal(f.calls.length, 1);
    const canaries = [apiKey, f.request.recipient.number, "cliniko:recall:30", "cliniko:recall:300", "Abby voice contact review v1"];
    assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `stop_${i}`, value }))), { ok: true, value: [] });
    const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    for (const canary of canaries) assert.equal(dump.includes(canary), false);
    for (const body of f.dncPosts) assert.equal(dump.includes(String(body.notes)), false);
  });
