// E2E-422: exact original-target signed outgoing cancellation; remote native/speech/grants are synthetic.
// Actual emitted original-target outgoing cancellation; remote native/speech/grants remain synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

import { assertSqlVerificationCodeCanary } from "../support/sql-verification-canary.ts";
import { withIsolatedVerificationSql } from "../support/isolated-verification-sql.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL;
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { outboundClinicalVoiceFixture } = await import(new URL("test/support/outbound-clinical-voice.js", emitted).href) as typeof import("../support/outbound-clinical-voice.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");

for (const scenario of ["accepted", "originalEdited", "peerQuota", "lostAcknowledgement"] as const)
test(`actual emitted signed cancellation private keypad with shared native180, SQL exclusion and backup privacy: ${scenario}`, { timeout: 170000 }, async () => withIsolatedVerificationSql(adminUrl, async ({ db, peer, connectionString, canaryWindow, defer }) => {
  const apiKey = `synthetic-outbound-cancel-${randomUUID()}-au5`, recipientNumber = `+614${randomInt(10_000_000, 99_999_999)}`;
  const identities = { accountSid: `AC${randomUUID().replaceAll("-", "")}`, callSid: `CA${randomUUID().replaceAll("-", "")}`,
    streamSid: `MZ${randomUUID().replaceAll("-", "")}`, authToken: `synthetic-clinical-${randomUUID()}`, contextKey: randomBytes(32),
    patientId: verificationCanaries[2]!, nativeRecallId: "30", recipientNumber };
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await outboundClinicalVoiceFixture({ apiKey, budget, recipientNumber, identities, sickDayAction: "cancel", lostCancellationResponse: scenario === "lostAcknowledgement",
    sessionEffects: (scope, binding) => new PostgresOutboundEffectBarrier(db, scope, binding) }); defer(f.close);
  assert.notEqual(recipientNumber, f.inbound.presentedCallerNumber);
  await f.open(); await f.mark();
  assert.deepEqual(f.spoken, ["Hello, this is Abby calling on behalf of the clinic."]);
  await f.say("I would like to cancel my appointment", { kind: "workflow", operation: "cancel" });
  const code = await f.waitForMail(); await f.mark(); await f.privateCode(code);
  const proof = await f.flow.cancellationProof(); assert.ok(proof);
  await f.say("Which appointment can I cancel", { kind: "appointments", verificationRef: proof.verificationRef,
    from: verificationNow, to: "2026-10-09T06:00:00.000Z" });
  assert.doesNotMatch(f.spoken.at(-1)!, /Option two/); await f.mark();
  await f.say("Cancel that appointment", { kind: "cancel", verificationRef: proof.verificationRef, targetRef: "selected" });
  const action = Object.values((await f.current()).actions)[0]!;
  assert.equal(action.mutation.request.kind, "cancel");
  if (action.mutation.request.kind !== "cancel") throw Error("Expected exact outgoing cancellation");
  assert.equal(action.mutation.request.target.appointmentRef, "91");
  assert.equal(f.cancellations, 0); await f.mark();
  if (scenario === "originalEdited") f.changeRequest();
  if (scenario === "peerQuota") {
    const competing = new PostgresClinikoRequestBudget(peer, { apiKey, maxPerMinute: 180 }); let claims = 0;
    while (await competing.claim() === null) assert.ok(++claims <= 180);
    assert.equal((await budget.claim())?.kind, "rateLimited");
  }
  await f.say("Yes", { kind: "affirm" });
  assert.equal(f.cancellations, scenario === "accepted" || scenario === "lostAcknowledgement" ? 1 : 0);
  assert.equal(Object.values((await f.current()).actions)[0]!.status === "committed", scenario === "accepted");
  if (scenario === "lostAcknowledgement") {
    assert.equal(Object.values((await f.current()).actions)[0]!.status, "uncertain");
    await f.mark(); await f.say("Did it finish", { kind: "outcome" }); assert.equal(f.cancellations, 1);
    assert.equal(Object.values((await f.current()).actions)[0]!.status, "uncertain");
  }
  const second = await f.transport.listen(f.transport.makeRouter()); defer(second.close);
  const response = await second.post(), duplicate = await second.open(await response.text()); assert.equal(await duplicate.outcome, "closed");
  assert.equal(f.transport.state.created, 1);
  await assertSqlVerificationCodeCanary(db, code, canaryWindow);
  const canaries = [apiKey, ...verificationCanaries, recipientNumber, f.actualCallId, f.sessionId, code, f.requestNotes,
    JSON.stringify(f.transport.original), f.transport.original.recallRef, f.transport.original.attempt.requestDigest,
    identities.accountSid, identities.callSid, identities.streamSid, identities.authToken, Buffer.from(identities.contextKey).toString("hex"),
    Buffer.from(identities.contextKey).toString("base64"), ...f.recalls.map(r => String(r.notes))];
  const probes = canaries.flatMap((text, i) => Array.from({ length: Math.ceil(text.length / 256) }, (_, part) => {
    const chunk = text.slice(part * 256, (part + 1) * 256); return { label: `outbound_cancel_${i}_${part}`, value: chunk.length < 4 ? text.slice(-4) : chunk };
  }));
  for (let i = 0; i < probes.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, probes.slice(i, i + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [connectionString, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  const copy = (v: string) => v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const text of canaries) {
    const json = JSON.stringify(text).slice(1, -1);
    for (const variant of [text, copy(text), json, copy(json)]) assert.equal(dump.includes(variant), false);
  }
  for (const secret of [apiKey, ...verificationCanaries, recipientNumber, code, f.requestNotes, identities.authToken])
    assert.equal(JSON.stringify([f.spoken, f.transcripts, f.modelTurns, f.sent]).includes(secret), false);
}));
