import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundRecipientRequestDigest } from "../../src/cliniko/outbound-recipient-request.ts";
import { outboundNumberStopsFixture } from "../support/outbound-number-stops.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/standalone/", import.meta.url);
const { ClinikoOutboundNumberStops } = await import(new URL("cliniko-outbound-number-stops.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-number-stops.ts");
const { OwnerFileOutboundContactAccount } = await import(new URL("owner-file-outbound-contact-account.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-contact-account.ts");
async function fixture(retired = false) {
  const apiKey = `synthetic-number-${randomUUID()}-au5`, scope = { tenantId: `number-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await outboundNumberStopsFixture({ apiKey, scope, budget, Reader: ClinikoOutboundNumberStops, Account: OwnerFileOutboundContactAccount,
    ...(retired ? { otherApiKey: `synthetic-retired-${randomUUID()}-au5` } : {}) });
  return { ...f, apiKey, physicalBudget: budget };
}
async function privacy(f: Awaited<ReturnType<typeof fixture>>, extra: string[] = []) {
  const canaries = [f.apiKey, f.first.request.recipient.number, "cliniko:recall:101", "cliniko:recall:201", "Abby voice contact review v1", ...extra];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `number_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
  for (const row of f.state.rows) if (typeof row.notes === "string") assert.equal(dump.includes(row.notes), false);
}
for (const scenario of ["clear", "stop", "archived", "retired", "approved", "denied", "otherStop", "quota", "cooldown", "max", "omittedRole", "futureRole"] as const)
  test(`emitted native number stop read actual180 shared budget and full backup privacy: ${scenario}`, { timeout: 30000 }, async t => {
    const f = await fixture(scenario === "retired"); t.after(f.close);
    if (["stop", "archived", "retired", "approved", "denied", "otherStop"].includes(scenario)) {
      const stop = f.stopOther();
      if (scenario === "archived") { const row = f.state.rows.find(r => r.id === "202")!; row.archived_at = f.first.state.now; row.updated_at = f.first.state.now; }
      if (["approved", "denied", "otherStop"].includes(scenario)) f.clearOther(stop);
      if (scenario === "denied") f.state.allow = q => q.operation !== "approveNumberStopResolution";
      if (scenario === "otherStop") f.append(f.first.next(f.first.first, { consent: "unknown", doNotCall: "blocked",
        reviewedAt: f.first.state.now, effectiveFrom: f.first.state.now }), "102");
    }
    if (scenario === "quota") for (let i = 0; i < 180; i++) if (await f.physicalBudget.claim() !== null) break;
    if (scenario === "cooldown") f.state.page = () => new Response(null, { status: 429, headers: { "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60) } });
    if (scenario === "max") f.state.rows = Array.from({ length: 500 }, (_, i) => {
      const review = { ...f.first.first, patientId: String(1000 + i), actionRef: randomUUID(), approvalRef: randomUUID() };
      return { ...f.first.row(review, String(i + 1)), ...(i < 50 ? {} : { notes: "unrelated native review text", recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/61" } } }) };
    });
    if (scenario === "omittedRole" || scenario === "futureRole") {
      const review = { ...f.first.first, actionRef: randomUUID(), approvalRef: randomUUID(), patientId: "33", contactRecallTypeId: "92", consent: "unknown" as const, doNotCall: "blocked" as const };
      f.state.rows.push({ ...f.first.row(review, "301"), notes: scenario === "futureRole" ? f.note(review).replace("Abby voice contact review v1", "Abby voice contact review v2") : f.note(review) });
    }
    const found = await f.read();
    if (["denied", "quota", "cooldown", "omittedRole", "futureRole"].includes(scenario)) assert.equal(found.ok, false);
    else assert.equal(value(found).disposition, ["clear", "approved", "max"].includes(scenario) ? "noRecordedStopObserved" : "blocked");
    if (scenario === "quota") assert.equal(f.calls.length, 0);
    if (scenario === "cooldown") assert.equal((await new PostgresClinikoRequestBudget(db, { apiKey: f.apiKey, maxPerMinute: 180 }).claim())?.kind, "rateLimited");
    if (scenario === "max") assert.equal(f.state.claims, 60);
    assert.ok(f.state.claims <= 70); await privacy(f);
  });
test("simultaneous emitted observations cannot borrow the other request's private grant", { timeout: 30000 }, async t => {
  const f = await fixture(); t.after(f.close); f.stopOther();
  const other = { ...f.first.request, actionRef: randomUUID(), recipient: { kind: "voice" as const, number: "+12025550999" } };
  const denied = outboundRecipientRequestDigest(f.first.request); f.state.allow = q => q.requestDigest !== denied;
  const [a, b] = await Promise.all([f.read(), f.reader.readForRequest(other, new AbortController().signal)]);
  assert.equal(a.ok, false); assert.equal(value(b).disposition, "noRecordedStopObserved"); assert.equal(value(b).requestDigest, outboundRecipientRequestDigest(other)); await privacy(f, [other.recipient.number]);
});
test("emitted source account and number observer remain readonly with an invalid database URL", { timeout: 30000 }, () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../support/outbound-number-stops-readonly.mjs", import.meta.url))], {
    env: { ...process.env, DATABASE_URL: "postgresql://readonly-number-stop.invalid/none", NODE_OPTIONS: "--max-old-space-size=128" }, timeout: 15000, maxBuffer: 1000 }).toString();
  assert.equal(output, "readonly-native-number-stop\n");
});
