// E2E-424, E2E-425: independently verified native callback context and exact original ownership.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { withIsolatedVerificationSql } from "../support/isolated-verification-sql.ts";
import { assertSqlVerificationCodeCanary } from "../support/sql-verification-canary.ts";
import type { ClinikoAdministrativeMemoConfig } from "../../src/standalone/administrative-memo-retention.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL, emitted = new URL("../../dist/runtime/", import.meta.url);
const { incomingClinicalCallFlowFixture } = await import(new URL("test/support/incoming-clinical-call-flow.js", emitted).href) as typeof import("../support/incoming-clinical-call-flow.ts");
const { clinikoWorkflowVoiceFixture, voiceUntil } = await import(new URL("test/support/cliniko-workflow-voice.js", emitted).href) as typeof import("../support/cliniko-workflow-voice.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { encodeOutboundRecipientRequest } = await import(new URL("src/cliniko/outbound-recipient-request.js", emitted).href) as typeof import("../../src/cliniko/outbound-recipient-request.ts");
const { ok } = await import(new URL("src/core/model.js", emitted).href) as typeof import("../../src/core/model.ts");
const { subjectMemoFixture } = await import(new URL("test/support/subject-memo.js", emitted).href) as typeof import("../support/subject-memo.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { decodeAdministrativeMemo } = await import(new URL("src/cliniko/administrative-memo.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo.ts");
const { decodeClinikoReview } = await import(new URL("src/cliniko/review-request.js", emitted).href) as typeof import("../../src/cliniko/review-request.ts");
const { administrativeMemoRecordBinding } = await import(new URL("src/cliniko/administrative-memo-records.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo-records.ts");

type NativeFixture = Awaited<ReturnType<typeof incomingClinicalCallFlowFixture>>;
type ServingCall = Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>>;
type Sql = Parameters<typeof clinikoWorkflowVoiceFixture>[0];

async function signedIncomingCall(db: Sql, f: NativeFixture, epoch = f.now, memo?: ClinikoAdministrativeMemoConfig) {
  let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
  const began = performance.now();
  const clock = () => { const at = new Date(Date.parse(epoch) + performance.now() - began).toISOString(); f.setTime(at); return at; };
  const nativeClock = () => call?.currentTime() ?? clock(), source = f.provision;
  const config = { ...f.config, clock, ...(memo ? { memo } : {}), verificationBudget: new PostgresPatientVerificationBudget(db, f.scope), missedCall: {
    ...source, requests: { ...source.requests, clock: nativeClock }, attempts: { ...source.attempts, clock: nativeClock },
    observations: { ...source.observations, clock: nativeClock },
    unanswered: { ...source.unanswered, records: { ...source.unanswered.records, clock: nativeClock } },
  } };
  call = await clinikoWorkflowVoiceFixture(db, config, () => async turn => {
    switch (turn.text) {
      case "Read my appointments": return ok({ kind: "workflow", operation: "appointments.read" });
      case "Why did the clinic call me": return ok({ kind: "missedCall" });
      case "Move my appointment": return ok({ kind: "workflow", operation: "reschedule" });
      case "Which appointment can I move": return ok({ kind: "reschedulingMenu", stage: "targets", from: f.now, to: "2026-11-03T10:05:00.000Z" });
      case "The first appointment": return ok({ kind: "reschedulingChoice", stage: "targets", choice: 1 });
      case "What times on Tuesday": return ok({ kind: "reschedulingMenu", stage: "offers", from: "2026-11-03", to: "2026-11-03" });
      case "The first time": return ok({ kind: "reschedulingChoice", stage: "offers", choice: 1 });
      case "Yes": return ok({ kind: "affirm" });
      case "Did it finish": return ok({ kind: "outcome" });
      default: throw Error("Unexpected synthetic incoming turn");
    }
  }, { clinicalHost: true, nativeIndividualChanges: true });
  return call;
}

async function assertPrivacy(db: Sql, connectionString: string, canaryWindow: Parameters<typeof assertSqlVerificationCodeCanary>[2],
  f: NativeFixture, calls: readonly ServingCall[], extraCanaries: readonly string[] = []) {
  for (const mail of f.mail) await assertSqlVerificationCodeCanary(db, mail.code, canaryWindow);
  const canaries = [f.native.config.apiKey, ...verificationCanaries, f.observation.callSid, f.attempt.actionRef, f.native.request.campaignRef,
    ...calls.map(call => call.callId), f.inbound.presentedCallerNumber!, f.native.request.recipient.number, ...f.mail.map(m => m.code),
    "unrelated-private-history-note", "discard-private-native-target-note", ...[...f.native.rows.values()].map(r => String(r.notes)), ...extraCanaries];
  for (const call of calls) {
    const state = await call.state();
    if (state.sessionLease) canaries.push(state.sessionLease.sessionId);
    await call.close();
  }
  const probes = [...new Set(canaries)].flatMap((value, index) => Array.from({ length: Math.ceil(value.length / 256) }, (_, part) => {
    const start = Math.min(part * 256, Math.max(0, value.length - 256));
    return { label: `incoming_${index}_${part}`, value: value.slice(start, start + 256) };
  }));
  for (let i = 0; i < probes.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, probes.slice(i, i + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [connectionString, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  const copy = (v: string) => v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const value of canaries) for (const text of [value, JSON.stringify(value).slice(1, -1)]) {
    assert.equal(dump.includes(text), false); assert.equal(dump.includes(copy(text)), false);
  }
}

for (const scenario of ["accepted", "originalEdited", "peerQuota", "memoAccepted", "memoWrongSubject", "memoWithdrawn", "memoLostStored", "memoClinicalUncertain"] as const)
test(`actual emitted signed incoming original move, two private codes, native180 and full SQL privacy: ${scenario}`, { timeout: 180_000 }, async () => withIsolatedVerificationSql(adminUrl, async ({ db, peer, connectionString, canaryWindow, defer }) => {
  const apiKey = "synthetic-outbound-au5", budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const campaignPatientId = verificationCanaries[2]; assert.ok(campaignPatientId);
  const f = await incomingClinicalCallFlowFixture({ rescheduling: true, unanswered: true, budget, campaignPatientId,
    ...(scenario === "memoClinicalUncertain" ? { lostWrite: true } : {}) }); defer(f.close);
  f.flow.dispose();
  let serving: ServingCall | undefined;
  const memo = scenario.startsWith("memo") ? subjectMemoFixture({ scope: f.scope, ...f.config.cliniko,
    authorRef: "clinic-approved-callback-memo", policy: { version: "callback-memo-v1", digest: "a".repeat(64) },
    clock: () => serving?.currentTime() ?? f.now, deadlineMs: 5000 }, campaignPatientId, {
    ...(scenario === "memoWrongSubject" ? { approvedPatientId: "43" } : {}),
    ...(scenario === "memoLostStored" ? { lostStored: true } : {}),
    barrierFor: (scope, binding) => new PostgresOutboundEffectBarrier(db, scope, binding),
  }) : undefined;
  if (memo) defer(memo.close);
  serving = await signedIncomingCall(db, f, f.now, memo?.config); defer(serving.close); f.bindNativeCall(serving.state);
  await serving.turn("Read my appointments"); await serving.mark(); await voiceUntil(() => f.mail.length === 1, "first incoming read code");
  let frames = serving.transcriptionFrames; await serving.verify(f.mail[0]!.code); assert.equal(serving.transcriptionFrames, frames);
  await serving.turn("Why did the clinic call me");
  assert.equal(serving.spoken.at(-1), "The clinic called about rescheduling your appointment. I can help with that, or you can contact reception.");
  await serving.mark(); await serving.turn("Move my appointment"); await serving.mark();
  await voiceUntil(() => f.mail.length === 2, "independent incoming rescheduling code");
  frames = serving.transcriptionFrames; await serving.verify(f.mail[1]!.code); assert.equal(serving.transcriptionFrames, frames);
  await serving.turn("Which appointment can I move"); assert.doesNotMatch(serving.spoken.at(-1)!, /Option two/);
  await serving.mark(); await serving.turn("The first appointment"); await serving.mark();
  await serving.turn("What times on Tuesday"); await serving.mark(); await serving.turn("The first time");
  const action = Object.values((await serving.state()).actions).at(-1)!; assert.ok(action); assert.equal(action.mutation.request.kind, "reschedule");
  if (action.mutation.request.kind !== "reschedule") throw Error("Expected original incoming move");
  assert.equal(action.mutation.request.target.appointmentRef, "71"); assert.equal(f.moves.length, 0); await serving.mark();
  if (scenario === "originalEdited") {
    const encoded = encodeOutboundRecipientRequest({ ...f.native.request, policy: { ...f.native.request.policy, version: "changed-at-confirmation" } }); assert.ok(encoded.ok);
    f.native.rows.get("30")!.notes = encoded.value;
  }
  if (scenario === "peerQuota") {
    const other = new PostgresClinikoRequestBudget(peer, { apiKey, maxPerMinute: 180 }); let claims = 0;
    while (await other.claim() === null) assert.ok(++claims <= 180);
    assert.equal((await budget.claim())?.kind, "rateLimited");
  }
  if (scenario === "memoWithdrawn") { assert.ok(memo); memo.control.permitted = false; }
  await serving.turn("Yes");
  const clinicalRefused = scenario === "originalEdited" || scenario === "peerQuota";
  const uncertain = scenario === "memoClinicalUncertain";
  const retained = Object.values((await serving.state()).actions).at(-1)!;
  assert.equal(f.moves.length, clinicalRefused ? 0 : 1);
  assert.equal(retained.status === "committed", !clinicalRefused && !uncertain);
  if (!clinicalRefused) assert.deepEqual(f.moves, [{ id: "71", startsAt: f.moveStarts[0] }]);
  if (memo) {
    const denied = scenario === "memoWrongSubject" || scenario === "memoWithdrawn";
    if (uncertain) assert.ok(["uncertain", "needsReview"].includes(retained.status));
    else {
      await voiceUntil(() => memo.outcomes.length === 1, "independent callback memo result");
      assert.equal(memo.outcomes[0]!.kind, denied ? "unavailable" : scenario === "memoLostStored" ? "uncertain" : "accepted");
      assert.equal(serving.spoken.at(-1), "Your appointment move is confirmed.");
    }
    assert.equal(memo.posts.length, denied || uncertain ? 0 : 1);
    assert.equal(memo.rows.length, denied || uncertain ? 0 : 1);
    for (const row of memo.rows) {
      const decoded = decodeAdministrativeMemo(row.content); assert.ok(decoded.ok);
      assert.equal(decoded.value.patientId, campaignPatientId); assert.equal(decoded.value.direction, "inbound");
      assert.equal(decoded.value.outcome.kind, "reschedulingObserved");
      assert.equal(decoded.value.outcome.appointmentRef, "cliniko:appointment:71");
      assert.equal(decoded.value.outcome.startsAt, f.moveStarts[0]);
      const review = decodeClinikoReview(f.reviews[0]!.notes); assert.ok(review.ok);
      assert.equal(review.value.request.patientId, campaignPatientId);
      assert.equal(decoded.value.sourceActionRef, review.value.marker);
      assert.notEqual(decoded.value.sourceActionRef, f.attempt.actionRef);
      const binding = administrativeMemoRecordBinding(memo.config.native, memo.authentication); assert.ok(binding);
      assert.deepEqual(await new PostgresOutboundEffectBarrier(db, f.scope, binding).claimOnce(decoded.value.actionRef),
        { ok: true, value: { claimed: false } });
    }
    const binding = administrativeMemoRecordBinding(memo.config.native, memo.authentication); assert.ok(binding);
    const purposes = await sql<{ total: number }>`select count(*)::int as total from outbound_effect_barriers where owner_binding = ${binding}`.execute(db);
    assert.equal(purposes.rows[0]!.total, denied || uncertain ? 0 : 1);
    await serving.mark(); await serving.turn("Did it finish");
    assert.equal(f.moves.length, 1); assert.equal(memo.posts.length, denied || uncertain ? 0 : 1);
    assert.deepEqual(Object.values((await serving.state()).actions).at(-1), retained);
  }
  assert.equal(f.earlier.starts_at, "2026-11-02T09:00:00.000001+11:00");
  await assertPrivacy(db, connectionString, canaryWindow, f, [serving], memo ? [Buffer.from(memo.key).toString("hex"),
    ...memo.rows.map(row => String(row.content))] : []);
}));

test("actual emitted signed fresh incoming owner needs a new code and rereads the clinic original without local context", { timeout: 180_000 }, async () => withIsolatedVerificationSql(adminUrl, async ({ db, connectionString, canaryWindow, defer }) => {
  const campaignPatientId = verificationCanaries[2]; assert.ok(campaignPatientId);
  const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-outbound-au5", maxPerMinute: 180 });
  const f = await incomingClinicalCallFlowFixture({ unanswered: true, budget, campaignPatientId }); defer(f.close); f.flow.dispose();
  const originalRows = [...f.native.rows.values()].map(row => structuredClone(row));
  const first = await signedIncomingCall(db, f); defer(first.close); f.bindNativeCall(first.state);
  await first.turn("Read my appointments"); await first.mark(); await voiceUntil(() => f.mail.length === 1, "first owner's read code");
  await first.verify(f.mail[0]!.code); await first.turn("Why did the clinic call me");
  assert.equal(first.spoken.at(-1), "The clinic called about rescheduling your appointment. I can help with that, or you can contact reception.");
  const firstHistoryReads = f.traffic.filter(q => q.path === "/v1/recalls").length; assert.ok(firstHistoryReads >= 2);
  await first.close();
  const second = await signedIncomingCall(db, f, first.currentTime()); defer(second.close); f.bindNativeCall(second.state);
  assert.notEqual(first.callId, second.callId);
  await second.turn("Why did the clinic call me");
  assert.equal(second.spoken.at(-1), "I don't know why the clinic called you. I can't verify an outbound-call reason from this call. Please contact the clinic directly.");
  assert.equal(f.traffic.filter(q => q.path === "/v1/recalls").length, firstHistoryReads);
  await second.mark(); await second.turn("Read my appointments"); await second.mark();
  await voiceUntil(() => f.mail.length === 2, "fresh owner's independent code");
  const frames = second.transcriptionFrames; await second.verify(f.mail[1]!.code); assert.equal(second.transcriptionFrames, frames);
  await second.turn("Why did the clinic call me");
  assert.equal(second.spoken.at(-1), "The clinic called about rescheduling your appointment. I can help with that, or you can contact reception.");
  assert.ok(f.traffic.filter(q => q.path === "/v1/recalls").length >= firstHistoryReads + 2);
  const owners = new Set<string>();
  for (const q of f.queries) if (q.operation === "approveIncomingCallContext") owners.add(q.callId);
  assert.deepEqual(owners, new Set([first.callId, second.callId]));
  assert.deepEqual([...f.native.rows.values()], originalRows); assert.deepEqual(f.writes, []); assert.equal(f.reviews.length, 0);
  await assertPrivacy(db, connectionString, canaryWindow, f, [first, second]);
}));
