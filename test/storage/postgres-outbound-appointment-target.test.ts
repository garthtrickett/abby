import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundTargetFixture } from "../support/outbound-appointment-target.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoOutboundAppointmentTarget: Reader } = await import(new URL("cliniko/outbound-appointment-target.js", emitted).href) as typeof import("../../src/cliniko/outbound-appointment-target.ts");
const { PostgresClinikoRequestBudget: Budget } = await import(new URL("storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
for (const scenario of ["pinned", "changed", "denied", "quota", "provider429"] as const)
  test(`actual emitted exact appointment reader native180 quota and backup privacy: ${scenario}`, { timeout: 30_000 }, async () => {
    const apiKey = `synthetic-target-${randomUUID()}-au5`, budget = new Budget(db, { apiKey, maxPerMinute: 180 });
    const f = outboundTargetFixture({ Reader, apiKey, budget,
      ...(scenario === "denied" ? { authority: { allows: async () => false } } : {}),
      ...(scenario === "provider429" ? { response: () => new Response(null, { status: 429 }) } : {}) });
    if (scenario === "quota") for (let n = 0; n < 180; n++) assert.equal(await budget.claim(), null);
    const initial = await f.observe();
    if (scenario === "denied") { assert.deepEqual(initial, { ok: false, error: { kind: "forbidden" } }); assert.equal(f.claims, 0); assert.equal(f.fetches, 0); }
    else if (scenario === "quota" || scenario === "provider429") {
      assert.equal(initial.ok, false); if (!initial.ok) assert.equal(initial.error.kind, "rateLimited");
      assert.equal(f.fetches, scenario === "quota" ? 0 : 1);
      const cold = new Budget(db, { apiKey, maxPerMinute: 180 }); assert.equal((await cold.claim())?.kind, "rateLimited");
    } else {
      const observed = value(initial), request = { ...f.request, purpose: "sickDay" as const, appointment: { ref: f.input.appointmentRef, digest: observed.digest } };
      if (scenario === "changed") f.row.updated_at = "2026-10-02T00:00:00.000002Z";
      const result = await value(f.make()).readForRequest(request, new AbortController().signal);
      if (scenario === "changed") assert.deepEqual(result, { ok: false, error: { kind: "mismatched" } });
      else assert.equal(value(result).digest, observed.digest);
      assert.equal(f.claims, 2); assert.equal(f.fetches, 2);
    }
    const canaries = [apiKey, f.request.recipient.number, f.input.appointmentRef, String(f.row.notes), String(f.row.patient_name), String(f.row.updated_at)];
    assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `target_${i}`, value }))), { ok: true, value: [] });
    const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
    for (const canary of canaries) assert.equal(dump.includes(canary), false);
  });
