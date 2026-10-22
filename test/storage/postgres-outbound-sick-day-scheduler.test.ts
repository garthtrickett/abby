import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneScan } from "../../src/storage/postgres-patient-phone-scan.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundSchedulerFixture } from "../support/outbound-scheduler.ts";
import { value } from "../support/outbound-records.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoOutboundScheduler } = await import(new URL("standalone/cliniko-outbound-scheduler.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-scheduler.ts");
const { ClinikoOutboundLaunchOwner } = await import(new URL("standalone/cliniko-outbound-launch-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const { OwnerFileOutboundCampaign } = await import(new URL("standalone/owner-file-outbound-campaign.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const { PostgresOutboundCapacity } = await import(new URL("storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");

for (const mode of ["accepted", "unknown", "targetDenied", "staleAudience", "staleEdge", "scheduleDenied", "lateSchedule", "quotaChanged", "concurrent", "abortAfterAck"] as const)
test(`actual emitted exact sick-day scheduler preserves SQL native180 and full privacy: ${mode}`, { timeout: 125_000 }, async t => {
  const apiKey = `synthetic-sick-day-scheduler-${randomUUID()}-au5`, scope = { tenantId: `sick-day-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const physical = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await outboundSchedulerFixture({ exactSickDay: true, apiKey, scope, patientId: verificationCanaries[2]!, budget: physical,
    Scheduler: ClinikoOutboundScheduler, runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign },
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) });
  t.after(f.close); assert.ok(f.targetedLaunch);
  const target = f.targetedLaunch, unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "index", locationId: "main" };
  const links = [{ normalizedPhone: "+61400111222", patientId: "101" }], fingerprint = "e".repeat(64), retainedRef = randomUUID();
  assert.ok((await new PostgresPatientPhoneIndex(db).publish(unrelated, links, "61", fingerprint)).ok);
  const scans = new PostgresPatientPhoneScan(db), begun = value(await scans.begin(unrelated, "61", fingerprint));
  assert.ok((await scans.append(unrelated, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
  assert.ok((await new PostgresOutboundEffectBarrier(db, unrelated, fingerprint).claimOnce(retainedRef)).ok);
  const preserved = {
    index: (await sql`select * from patient_phone_index where tenant_id = ${unrelated.tenantId}`.execute(db)).rows,
    effect: (await sql`select * from outbound_effect_barriers where effect_ref = ${retainedRef}`.execute(db)).rows,
  };
  const controller = new AbortController();
  if (mode === "unknown") f.controls.mode = "unknown";
  if (mode === "targetDenied") f.deny("approveAppointmentTarget");
  if (mode === "staleAudience") f.scheduleState.onAccount = () => { target.targetRow.updated_at = "2026-10-02T00:00:00.000002Z"; };
  if (mode === "staleEdge") f.controls.beforeEdge = () => { target.targetState.live = false; };
  if (mode === "scheduleDenied") f.scheduleState.schedule = false;
  if (mode === "lateSchedule") f.controls.beforeEdge = () => { f.scheduleState.schedule = false; };
  if (mode === "abortAfterAck") {
    f.controls.mode = "loseAfterAck"; f.controls.afterAck = () => { controller.abort(); };
  }
  if (mode === "quotaChanged") {
    for (let n = 0; n < 100; n++) assert.equal(await physical.claim(), null);
    const wait = f.schedulerPorts.waitForQuota;
    f.schedulerPorts.waitForQuota = async (ms, signal) => {
      await delay(ms, undefined, { signal });
      target.targetRow.cancelled_at = f.state.now;
      await wait(ms, signal);
    };
  }
  const began = performance.now(), scheduler = f.makeScheduler();
  const results = mode === "concurrent" ? await Promise.all([scheduler.tick(controller.signal), f.makeScheduler().tick(controller.signal)]) : [await scheduler.tick(controller.signal)];
  const accepted = ["accepted", "concurrent", "abortAfterAck"].includes(mode) ? 1 : 0;
  assert.equal(results.reduce((n, r) => n + r.accepted, 0), accepted);
  assert.equal(results.reduce((n, r) => n + r.unknown, 0), mode === "unknown" ? 1 : 0);
  assert.equal(f.calls.length, accepted || mode === "unknown" ? 1 : 0);
  const possible = ["accepted", "unknown", "staleEdge", "lateSchedule", "concurrent", "abortAfterAck"].includes(mode) ? 1 : 0;
  assert.equal(f.posts, possible);
  assert.equal((await sql`select allocation_ref from outbound_capacity_allocations where tenant_id = ${scope.tenantId} and released_at is null`.execute(db)).rows.length, possible);
  if (mode === "scheduleDenied") assert.equal(f.scheduleState.accountReads, 0);
  if (mode === "quotaChanged") {
    assert.equal(f.scheduleState.waits, 1); assert.ok(performance.now() - began >= 55_000, "actual unchanged SQL cooldown elapsed; no quota row reset");
  }
  if (accepted) {
    assert.deepEqual(Object.keys(f.calls[0]!).sort(), ["capacityAllocationRef", "effectRef", "number", "profileRef"]);
    assert.ok(target.targetLaunchQueries.some(q => q.operation === "approveAppointmentTarget" && q.target?.digest === target.observed.digest));
  }
  assert.ok(f.claims <= 180);
  const secrets = [apiKey, f.request.patientId, f.request.recipient.number, "cliniko:appointment:71", "cliniko:recall:30",
    "discard-private-native-target-note", "discard-private-native-target-name", f.requestRow.notes];
  const summary = JSON.stringify(results);
  for (const secret of secrets) assert.equal(summary.includes(secret), false);
  const probes = secrets.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 200) }, (_, n) =>
    ({ label: `sick_day_${i}_${n}`, value: value.slice(Math.min(n * 200, value.length - 4), n * 200 + 200) })));
  for (let n = 0; n < probes.length; n += 12) assert.deepEqual(value(await scanPatientDataCanaries(db, probes.slice(n, n + 12))), []);
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  const copy = (v: string) => v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const secret of secrets) {
    const encoded = JSON.stringify(secret).slice(1, -1);
    for (const probe of [secret, copy(secret), encoded, copy(encoded)]) assert.equal(dump.includes(probe), false);
  }
  assert.deepEqual((await sql`select * from patient_phone_index where tenant_id = ${unrelated.tenantId}`.execute(db)).rows, preserved.index);
  assert.deepEqual((await sql`select * from outbound_effect_barriers where effect_ref = ${retainedRef}`.execute(db)).rows, preserved.effect);
  assert.ok((await scans.verifyPage(unrelated, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
  assert.ok(dump.includes(retainedRef));
  const budgets = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
  assert.ok(budgets.length > 0 && budgets.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length <= 180));
});
