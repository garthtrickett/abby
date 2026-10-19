import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundDncRecordFixture } from "../support/outbound-dnc-records.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoOutboundDncRecords } = await import(new URL("cliniko/outbound-dnc-records.js", emitted).href) as typeof import("../../src/cliniko/outbound-dnc-records.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
for (const scenario of ["accepted", "denied", "unknown", "lateGrant", "archive", "foreignAck"] as const)
  test(`actual emitted blocked DNC decision native180 opaque SQL and backup privacy: ${scenario}`, { timeout: 30_000 }, async t => {
    const apiKey = `synthetic-dnc-${randomUUID()}-au5`, scope = { tenantId: `dnc-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
    const physical = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 }); let claims = 0;
    const f = await outboundDncRecordFixture({ apiKey, scope, Records: ClinikoOutboundDncRecords,
      budget: { claim: () => { claims++; return physical.claim(); }, observe429: physical.observe429.bind(physical) },
      barrierFactory: (s, owner) => new PostgresOutboundEffectBarrier(db, s, owner) }); t.after(f.close);
    if (scenario === "denied") f.dncControls.producer = false;
    if (scenario === "unknown") f.dncControls.response = () => { throw new Error("Synthetic lost native ACK"); };
    if (scenario === "lateGrant") f.dncControls.response = row => { f.dncControls.current = false; return Response.json(row, { status: 201 }); };
    if (scenario === "foreignAck") f.dncControls.response = row => Response.json({ ...row, patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/999" } } }, { status: 201 });
    const result = await f.retain();
    if (scenario === "denied") assert.deepEqual(result, { ok: false, error: { kind: "forbidden" } });
    else assert.equal(value(result).kind, ["unknown", "foreignAck"].includes(scenario) ? "uncertain" : "accepted");
    const stored = (await sql`select effect_ref from outbound_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db)).rows;
    assert.equal(stored.length, scenario === "denied" ? 0 : 1); assert.equal(f.dncCalls.length, scenario === "denied" ? 0 : 1);
    if (scenario !== "denied") {
      assert.equal((await value(f.make()).retainDecisionOnce(f.review, "2026-11-02", new AbortController().signal)).ok, false);
      f.dncControls.current = true;
      if (scenario === "archive") { const row = f.controls.rows.find(r => r.id === "102")!; row.recalled = true; row.recalled_at = f.state.now; row.archived_at = f.state.now; }
      const reader = value(ClinikoOutboundDncRecords.createReadOnly(f.config, f.definition, f.dncAuthority, f.dncPort));
      const found = value(await reader.readDecision({ recallRef: "cliniko:recall:102", actionRef: f.review.actionRef, patientId: f.review.patientId }, new AbortController().signal));
      assert.equal(found.record.doNotCall, "blocked"); assert.equal(found.record.consent, "unknown");
      assert.equal(value(await f.read()).disposition, "blocked");
      assert.equal(f.dncCalls.filter(c => c.method === "POST").length, 1);
    }
    assert.ok(claims <= 180);
    const canaries = [apiKey, f.review.recipient.number, "Abby voice contact review v1", "cliniko:recall:102", f.review.reviewerRef];
    assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `dnc_${i}`, value }))), { ok: true, value: [] });
    const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
    for (const canary of canaries) assert.equal(dump.includes(canary), false);
  });
