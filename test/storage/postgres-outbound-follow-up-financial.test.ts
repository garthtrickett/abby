// E2E-421: original-patient signed follow-up booking with actual private financial consent; synthetic remote grants and speech.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { financialConsentReadback } from "../../src/standalone/financial-consent-readback.ts";
import { decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";

import { assertSqlVerificationCodeCanary } from "../support/sql-verification-canary.ts";
import { withIsolatedVerificationSql, assertIsolatedVerificationCanary } from "../support/isolated-verification-sql.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL;
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { financialCall, selectBooking, playTerms, until } = await import(new URL("test/support/outbound-follow-up-financial.js", emitted).href) as typeof import("../support/outbound-follow-up-financial.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresFinancialEffectBarrier } = await import(new URL("src/storage/postgres-financial-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-financial-effect-barrier.ts");
const { financialRecordOwnerBinding } = await import(new URL("src/cliniko/financial-record-retention.js", emitted).href) as typeof import("../../src/cliniko/financial-record-retention.ts");

for (const scenario of ["accepted", "originalEdited", "peerQuota"] as const)
test(`emitted outgoing follow-up private financial consent, shared native180 and backup privacy: ${scenario}`, { timeout: 170000 }, async () => withIsolatedVerificationSql(adminUrl, async ({ db, peer, connectionString, canaryWindow, defer }) => {
  const apiKey = `synthetic-follow-up-${randomUUID()}-au5`, recipientNumber = `+614${randomInt(10_000_000, 99_999_999)}`;
  const identities = { accountSid: `AC${randomUUID().replaceAll("-", "")}`, callSid: `CA${randomUUID().replaceAll("-", "")}`,
    streamSid: `MZ${randomUUID().replaceAll("-", "")}`, authToken: `synthetic-follow-up-${randomUUID()}`, contextKey: randomBytes(32),
    patientId: verificationCanaries[2]!, nativeRecallId: "900", recipientNumber };
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const c = await financialCall({ apiKey, budget, recipientNumber, identities,
    sessionEffects: (scope, binding) => new PostgresOutboundEffectBarrier(db, scope, binding),
    financialBarrier: native => {
      const binding = financialRecordOwnerBinding(native); assert.ok(binding.ok);
      return new PostgresFinancialEffectBarrier(db, native.scope, binding.value);
    } }); defer(c.close);
  const f = c.f, { code, input } = await selectBooking(c);
  assert.notEqual(recipientNumber, f.inbound.presentedCallerNumber);
  await f.mark(); const privateStart = f.spoken.length; await playTerms(c);
  const privateSpoken = f.spoken.slice(privateStart); assert.equal(f.bookings, 0);
  await f.privateKey("1"); await until(() => input.readySelection !== undefined, "actual separate financial consent");
  await f.privateQuiet(); await f.say("continue booking", { kind: "clarify" }); await f.mark();
  const action = Object.values((await f.current()).actions)[0]!; assert.equal(action.status, "awaitingConfirmation");
  if (scenario === "originalEdited") f.changeRequest();
  if (scenario === "peerQuota") {
    const competing = new PostgresClinikoRequestBudget(peer, { apiKey, maxPerMinute: 180 }); let claims = 0;
    while (await competing.claim() === null) assert.ok(++claims <= 180);
    assert.equal((await budget.claim())?.kind, "rateLimited");
  }
  await f.say("Yes", { kind: "affirm" });
  assert.equal(f.bookings, scenario === "accepted" ? 1 : 0);
  assert.equal(Object.values((await f.current()).actions)[0]!.status === "committed", scenario === "accepted");
  const observations = [...c.funding.rows.values()].filter(row => String(row.notes).includes("financial booking observation"));
  assert.equal(observations.length, scenario === "accepted" ? 1 : 0);
  const second = await f.transport.listen(f.transport.makeRouter()); defer(second.close);
  const response = await second.post(), replay = await second.open(await response.text()); assert.equal(await replay.outcome, "closed");
  assert.equal(f.transport.state.created, 1);
  const financialNotes = [...c.funding.rows.values()].map(row => String(row.notes));
  const retained = [...c.funding.rows.values()].find(row => String(row.notes).includes("financial intent")); assert.ok(retained);
  const intent = decodeClinikoFinancialIntent(retained.notes); assert.ok(intent.ok);
  await assertSqlVerificationCodeCanary(db, code, canaryWindow);
  const canaries = [apiKey, ...verificationCanaries, recipientNumber, f.actualCallId, f.sessionId, code, f.requestNotes,
    JSON.stringify(f.transport.original), f.transport.original.recallRef, f.transport.original.attempt.requestDigest,
    identities.accountSid, identities.callSid, identities.streamSid, identities.authToken, identities.contextKey.toString("hex"),
    identities.contextKey.toString("base64"), ...f.recalls.map(row => String(row.notes)), ...financialNotes, JSON.stringify(intent.value.recipient)];
  const probes = canaries.flatMap((text, i) => Array.from({ length: Math.ceil(text.length / 256) }, (_, part) => {
    const chunk = text.slice(part * 256, (part + 1) * 256); return { label: `follow_up_${i}_${part}`, value: chunk.length < 4 ? text.slice(-4) : chunk };
  }));
  if (scenario === "accepted") await assertIsolatedVerificationCanary(adminUrl, code);
  for (let i = 0; i < probes.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, probes.slice(i, i + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [connectionString, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  const copy = (v: string) => v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const text of canaries) {
    const json = JSON.stringify(text).slice(1, -1);
    for (const variant of [text, copy(text), json, copy(json)]) assert.equal(dump.includes(variant), false);
  }
  // The authenticated caller must hear the exact recipient in the private
  // financial readback. That deliberate private clip is not public dialogue.
  assert.deepEqual(privateSpoken, financialConsentReadback(intent.value,
    "The clinic will review late payment; no automatic refund is promised.", "Australia/Sydney"));
  assert.ok(privateSpoken.join(" ").includes(intent.value.recipient.address));
  const publicSpoken = [...f.spoken.slice(0, privateStart), ...f.spoken.slice(privateStart + privateSpoken.length)];
  for (const secret of [apiKey, ...verificationCanaries, recipientNumber, code, f.requestNotes, identities.authToken, "GBP 50.00"])
    assert.equal(JSON.stringify([publicSpoken, f.transcripts, c.seen, f.sent]).includes(secret), false);
  // Clinical SAM transiently binds the independently verified native patient.
  // It must not hold financial text/recipient/code or reach local persistence;
  // the all-column and full backup scans above still include that patient ID.
  assert.equal(action.mutation.request.kind, "book");
  if (action.mutation.request.kind !== "book") throw Error("Expected original-patient booking");
  assert.equal(action.mutation.request.patient.patientRef, intent.value.patientId);
  const transient = JSON.stringify(await f.current());
  for (const secret of [apiKey, verificationCanaries[0]!, verificationCanaries[1]!, recipientNumber, code, f.requestNotes, identities.authToken, "GBP 50.00"])
    assert.equal(transient.includes(secret), false);
  assert.ok(c.claims <= 180);
}));
