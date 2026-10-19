import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundTerminalOwnerFixture } from "../support/outbound-terminal-owner.ts";
import { value } from "../support/outbound-records.ts";
import { encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoOutboundTerminalOwner } = await import(new URL("standalone/cliniko-outbound-terminal-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-terminal-owner.ts");
const { ClinikoOutboundLaunchOwner } = await import(new URL("standalone/cliniko-outbound-launch-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const { OwnerFileOutboundCampaign } = await import(new URL("standalone/owner-file-outbound-campaign.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const { PostgresOutboundCapacity } = await import(new URL("storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
for (const scenario of ["terminal", "unknown", "active", "withdrawRelease", "withdrawNative", "foreignProof", "changedAllocation"] as const)
  test(`actual emitted terminal owner native180 SQL release and backup privacy: ${scenario}`, { timeout: 30_000 }, async t => {
    const apiKey = `synthetic-terminal-${randomUUID()}-au5`, scope = { tenantId: `terminal-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
    const f = await outboundTerminalOwnerFixture({ apiKey, scope, budget: new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 }),
      runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign }, TerminalOwner: ClinikoOutboundTerminalOwner,
      effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) });
    t.after(f.close);
    if (scenario === "unknown" || scenario === "active") f.stateTerminal.provider = scenario;
    if (scenario === "withdrawRelease") f.stateTerminal.beforeRelease = () => { f.stateTerminal.withdrawn = "releaseCapacity"; };
    if (scenario === "withdrawNative") f.stateTerminal.beforeRelease = () => { f.stateTerminal.readLive = false; };
    if (scenario === "foreignProof") f.stateTerminal.proofPatch = { effectRef: randomUUID() };
    if (scenario === "changedAllocation") {
      f.row.notes = value(encodeOutboundLaunchAttempt({ ...f.attempt, capacityAllocationRef: randomUUID() }));
    }
    const before = f.claims, result = await f.inspect();
    if (scenario === "terminal") {
      assert.deepEqual(value(result), { kind: "terminal", released: true });
      assert.deepEqual(value(await f.inspect()), { kind: "terminal", released: false });
    } else if (["unknown", "active", "changedAllocation"].includes(scenario)) assert.deepEqual(value(result), { kind: "held" });
    else assert.equal(result.ok, false);
    assert.ok(f.claims - before <= 16, "two complete reread profiles share real remaining account budget"); assert.ok(f.claims <= 180);
    const rows = (await sql<{ allocation_ref: string; released_at: Date | null }>`select allocation_ref,released_at from outbound_capacity_allocations where tenant_id = ${scope.tenantId}`.execute(db)).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0]!.allocation_ref, f.attempt.capacityAllocationRef);
    assert.equal(rows[0]!.released_at !== null, scenario === "terminal");
    assert.equal(f.posts, 1); assert.equal(f.calls.length, 1);
    const effects = (await sql`select effect_ref from outbound_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db)).rows;
    assert.equal(effects.length, 3, "terminal observation leaves all original record/approval/effect exclusions intact");
    const canaries = [apiKey, f.request.recipient.number, "Abby possible outbound launch v2", "cliniko:recall:30", "generic-clinic-greeting"];
    assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `terminal_${i}`, value }))), { ok: true, value: [] });
    const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
    for (const canary of canaries) assert.equal(dump.includes(canary), false);
  });
