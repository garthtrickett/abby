import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomInt, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

import { captureSqlVerificationCanaryWindow, assertSqlVerificationCodeCanary } from "../support/sql-verification-canary.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL), peer = connectPostgres(process.env.DATABASE_URL);
after(async () => { await Promise.all([db.destroy(), peer.destroy()]); });
const canaryWindow = await captureSqlVerificationCanaryWindow(db);
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { outboundClinicalReschedulingFixture } = await import(new URL("test/support/outbound-clinical-rescheduling.js", emitted).href) as typeof import("../support/outbound-clinical-rescheduling.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { outboundLaunchAttemptDigest } = await import(new URL("src/cliniko/outbound-launch-attempt.js", emitted).href) as typeof import("../../src/cliniko/outbound-launch-attempt.ts");
const { PostgresPatientPhoneIndex } = await import(new URL("src/storage/postgres-patient-phone-index.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-index.ts");
const usedRecipients = new Set<string>();

for (const scenario of ["accepted", "originalEdited", "peerQuota"] as const)
test(`emitted original-patient outpatient move with shared PostgreSQL180 and complete privacy: ${scenario}`, { timeout: 170000 }, async t => {
  const apiKey = `synthetic-outbound-clinical-${randomUUID()}-au5`;
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  let recipientNumber: string;
  do { recipientNumber = `+614${randomInt(10_000_000, 99_999_999)}`; } while (usedRecipients.has(recipientNumber));
  usedRecipients.add(recipientNumber);
  const f = await outboundClinicalReschedulingFixture({ apiKey, budget, recipientNumber }); t.after(f.close);
  assert.equal(f.receipt.admission.direction, "outbound");
  assert.notEqual(f.recipientNumber, f.inbound.presentedCallerNumber, "The independent incoming fixture is not this outgoing recipient");
  assert.equal(f.context.verificationBinding().number, f.recipientNumber);
  await f.verify();
  assert.equal((await f.readMenu("targets")).ok, true); await f.play();
  assert.doesNotMatch((await f.state()).callerMessages.at(-1) ?? "", /Option two/);
  assert.equal((await f.selectMenu("targets")).ok, true); await f.play();
  assert.equal((await f.readMenu("offers")).ok, true); await f.play();
  assert.equal((await f.selectMenu("offers")).ok, true);
  const action = Object.values((await f.state()).actions)[0]!;
  assert.equal(action.mutation.request.kind, "reschedule");
  if (action.mutation.request.kind !== "reschedule") throw Error("Expected exact outgoing move");
  assert.equal(action.mutation.request.target.appointmentRef, "91");
  if (scenario === "originalEdited") f.editOriginalRequest();
  if (scenario === "peerQuota") {
    const competing = new PostgresClinikoRequestBudget(peer, { apiKey, maxPerMinute: 180 });
    let claims = 0;
    while (await competing.claim() === null) { assert.ok(++claims <= 180); }
    assert.equal((await budget.claim())?.kind, "rateLimited");
  }
  assert.equal((await f.confirm()).ok, true); await f.drain();
  assert.equal(f.patches, scenario === "accepted" ? 1 : 0);
  assert.equal(Object.values((await f.state()).actions)[0]!.status === "committed", scenario === "accepted");
  await assertSqlVerificationCodeCanary(db, f.mail[0]!.code, canaryWindow);
  const canaries = [apiKey, ...verificationCanaries, f.original.attempt.patientId, f.original.attempt.requestDigest,
    outboundLaunchAttemptDigest(f.original.attempt)!, f.original.recallRef, f.recipientNumber,
    f.callId, f.sessionId, f.mail[0]!.code, f.originalRequestNotes, ...f.recalls.map(r => String(r.notes))];
  const probes = canaries.flatMap((text, i) => Array.from({ length: Math.ceil(text.length / 256) }, (_, part) => {
    const chunk = text.slice(part * 256, (part + 1) * 256); return { label: `outbound_clinical_${i}_${part}`, value: chunk.length < 4 ? text.slice(-4) : chunk };
  }));
  for (let i = 0; i < probes.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, probes.slice(i, i + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  const copy = (v: string) => v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const text of canaries) {
    const json = JSON.stringify(text).slice(1, -1);
    for (const variant of [text, copy(text), json, copy(json)]) assert.equal(dump.includes(variant), false);
  }
  if (scenario === "accepted") {
    // After proving absence, deliberately publish this case's exact phone via
    // the permitted index owner. The unchanged all-column scanner must find it.
    assert.equal((await new PostgresPatientPhoneIndex(db).publish({ tenantId: `clinical-phone-probe-${randomUUID()}`, clinicId: "probe" },
      [{ normalizedPhone: f.recipientNumber, patientId: "101" }], "61", "e".repeat(64))).ok, true);
    const observed = await scanPatientDataCanaries(db, [{ label: "positive_outbound_phone", value: f.recipientNumber }]);
    assert.equal(observed.ok, true);
    if (observed.ok) assert.ok(observed.value.some(hit => hit.table === "patient_phone_index" && hit.column === "normalized_phone" && hit.label === "positive_outbound_phone"));
  }
});
