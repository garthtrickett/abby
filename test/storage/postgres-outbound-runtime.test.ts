import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundRuntimeOwnersFixture } from "../support/outbound-runtime-owners.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { bindOutboundVoiceRuntime } = await import(new URL("voice/outbound-runtime.js", emitted).href) as typeof import("../../src/voice/outbound-runtime.ts");
const { ClinikoOutboundTerminalOwner } = await import(new URL("standalone/cliniko-outbound-terminal-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-terminal-owner.ts");
const { ClinikoOutboundLaunchOwner } = await import(new URL("standalone/cliniko-outbound-launch-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const { OwnerFileOutboundCampaign } = await import(new URL("standalone/owner-file-outbound-campaign.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const { PostgresOutboundCapacity } = await import(new URL("storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
for (const engine of ["abby", "vapi"] as const)
  for (const scenario of ["accepted", "unknown", "denied", "switch"] as const)
    test(`emitted synthetic ${engine} runtime ${scenario} shares native180 SQL owners and backup privacy`, { timeout: 30_000 }, async t => {
      const apiKey = `synthetic-runtime-${randomUUID()}-au5`, scope = { tenantId: `runtime-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
      const f = await outboundRuntimeOwnersFixture({ engine, apiKey, scope, bind: bindOutboundVoiceRuntime, TerminalOwner: ClinikoOutboundTerminalOwner,
        runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign }, budget: new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 }),
        effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) });
      t.after(f.close);
      if (scenario === "denied") f.deny("approveLaunch");
      if (scenario === "unknown" || scenario === "switch") { f.controls.mode = "unknown"; f.runtimeState.terminal = "unknown"; }
      const result = await f.launchSelected();
      if (scenario === "denied") { assert.equal(result.ok, false); assert.equal(f.calls.length, 0); }
      else {
        assert.deepEqual(value(result), { kind: scenario === "accepted" ? "accepted" : "unknown", capacity: "held" });
        assert.equal(f.posts, 1); assert.equal(f.calls.length, 1);
        if (scenario === "switch") {
          f.controls.providerDigest = "d".repeat(64); f.controls.mode = "accepted";
          const next = value(bindOutboundVoiceRuntime(f.adapter)); Object.assign(f.ports, { provider: next.launch });
          assert.equal((await value(f.make()).launchOnce(f.binding, new AbortController().signal)).ok, false);
          assert.equal((await f.inspect()).ok, false);
        } else assert.deepEqual(value(await f.inspect()), scenario === "accepted" ? { kind: "terminal", released: true } : { kind: "held" });
        assert.equal(f.calls.length, 1);
      }
      const allocations = (await sql<{ released_at: Date | null }>`select released_at from outbound_capacity_allocations where tenant_id = ${scope.tenantId}`.execute(db)).rows;
      assert.equal(allocations.length, scenario === "denied" ? 0 : 1);
      if (allocations.length) assert.equal(allocations[0]!.released_at !== null, scenario === "accepted");
      const effects = (await sql`select effect_ref from outbound_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db)).rows;
      assert.equal(effects.length, scenario === "denied" ? 0 : 3); assert.ok(f.claims <= 180);
      const note = f.requestRow.notes as string, noteWindows: string[] = [];
      // Cover every byte, including a short final tail, within the scanner's
      // existing 256-character bound. Whole-note backup absence stays checked.
      for (let offset = 0; offset < note.length; offset += 253) {
        const window = note.slice(offset, offset + 256); if (window.length >= 4) noteWindows.push(window);
      }
      assert.ok(noteWindows.length > 0);
      const canaries = [apiKey, f.request.recipient.number, "cliniko:recall:30", ...noteWindows];
      assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `runtime_${i}`, value }))), { ok: true, value: [] });
      const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
      for (const canary of canaries) assert.equal(dump.includes(canary), false);
      assert.equal(dump.includes(note), false);
    });
