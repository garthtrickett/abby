import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { commandProgress } from "../../src/reference/command-progress.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { representativeChangeCallFixture } from "../support/representative-change-call.ts";
import { subjectMemoFixture } from "../support/subject-memo.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

for (const guardian of [false, true])
for (const operation of ["cancel", "reschedule"] as const)
for (const mode of ["accepted", "wrongSubjectGrant", "withdrawn", "lostStored", "nativeUncertain", ...(operation === "reschedule" ? ["fastBudgetExhausted"] as const : [])] as const)
test(`${guardian ? "guardian" : "representative"} ${operation} memo belongs to the separately verified patient: ${mode}`, { timeout: 120000 }, async t => {
  const physical = new ClinikoReadBudget(180); let claims = 0, deniedClaims = 0;
  const budget = { claim: () => { claims++; const result = physical.claim(); if (result) deniedClaims++; return result; }, observe429: physical.observe429.bind(physical) };
  const subjects = ["583746192837465", "683746192837465"] as const;
  const f = await representativeChangeCallFixture(operation, { budget, subjectIds: subjects, ...(guardian ? { guardian: true } : {}) }); f.flow.dispose();
  const began = performance.now();
  const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); f.f.setTime(now); return now; };
  const turn = (id: string, text?: string) => ({ ...f.f.turn(id, text), at: clock() });
  const play = async () => {
    const pending = (await f.f.state()).pendingPresentationId!; assert.ok(pending);
    resultValue(await f.f.runtime.startPresentation(f.f.callId, pending, f.f.sessionId, clock()));
    resultValue(await f.f.runtime.resolvePresentation(f.f.callId, pending, "played", f.f.sessionId, clock()));
  };
  const targetBefore = structuredClone(f.rows.get("91"));
  const callerBefore = structuredClone(f.rows.get("93")), otherBefore = structuredClone(f.rows.get("92"));
  const memo = subjectMemoFixture({ scope: f.f.scope, ...f.flowConfig.cliniko,
    authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) },
    clock, deadlineMs: 5000 }, subjects[0], {
    ...(mode === "wrongSubjectGrant" ? { approvedPatientId: subjects[1] } : {}),
    ...(mode === "lostStored" ? { lostStored: true } : {}) });
  const flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, clock, memo: memo.config, fetchPort: async (url, init) => {
    const response = await f.flowConfig.fetchPort(url, init);
    if (mode === "withdrawn" && init?.method === "PATCH") memo.control.permitted = false;
    return response;
  } }));
  t.after(async () => { memo.close(); flow.dispose(); await f.close(); });
  const reception = new TextReception(f.f.ledger, f.f.policies, flow, undefined, {
    list: (...args) => flow.appointments!.list(...args), select: (...args) => flow.appointments!.select!(...args) }, undefined, undefined, clock);
  const stages: unknown[] = [];
  const readMenu = flow.readReschedulingMenu.bind(flow), selectMenu = flow.selectReschedulingMenu.bind(flow), resolveChange = flow.resolveAppointmentChange.bind(flow);
  flow.readReschedulingMenu = async (...args: Parameters<typeof readMenu>) => { const result = await readMenu(...args);
    stages.push({ phase: "read", stage: args[0].stage, ok: result.ok, ...(result.ok ? { resultStage: result.value.stage, choices: result.value.choices.length } : { code: result.error.kind }) }); return result; };
  flow.selectReschedulingMenu = async (...args: Parameters<typeof selectMenu>) => { const result = await selectMenu(...args);
    stages.push({ phase: "select", stage: args[0].stage, ok: result.ok, ...(result.ok ? { kind: result.value.kind } : { code: result.error.kind }) }); return result; };
  flow.resolveAppointmentChange = async (...args: Parameters<typeof resolveChange>) => { const result = await resolveChange(...args);
    stages.push({ phase: "resolve", ok: result.ok, ...(!result.ok ? { code: result.error.kind } : {}) }); return result; };
  const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.f.scope }, f.f.policies, reception,
    undefined, undefined, undefined, f.f.ledger);
  resultValue(await reception.startWorkflow(f.f.scope, turn("memo-related-start", guardian ? "Change an appointment for my child" : "Change an appointment for my partner"), operation,
    clock(), (await f.f.state()).conversationRevision, undefined, false, undefined, true)); await play();
  const owner = flow.representativeInputOwner; assert.ok(owner);
  assert.equal(owner.beginCallerVerification(), true); await f.waitForMail(1);
  assert.equal((await owner.submitCallerCode(f.mail[0]!.code)).verified, true);
  resultValue(await owner.selectPatient(f.r.identity)); assert.equal(owner.beginPatientVerification(), true); await f.waitForMail(2);
  assert.notEqual(f.mail[0]!.email, f.mail[1]!.email);
  assert.equal(f.mail[1]!.email, f.r.patients.get(subjects[0])!.email);
  assert.equal((await flow.submitCode(f.mail[1]!.code)).verified, true);
  // A patient-paced conversation ages the shared rolling window naturally.
  // Never reset the budget, raise its cap or extend a clinical action deadline.
  if (operation === "reschedule" && mode !== "nativeUncertain" && mode !== "fastBudgetExhausted") {
    for (const delay of [15000, 15000, 15000, 16000]) {
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      const lease = (await f.f.state()).sessionLease; assert.ok(lease);
      resultValue(await f.f.runtime.renewSession(f.f.callId, f.f.sessionId, lease.version, clock()));
    }
  }
  if (operation === "cancel") {
    const grant = await flow.cancellationProof(); assert.ok(grant);
    resultValue(await agent.submit({ kind: "appointments.read.v1", turn: turn("memo-related-list"), verificationRef: grant.verificationRef,
      from: clock(), to: "2026-10-09T06:00:00.000Z", now: clock() })); await play();
    resultValue(await agent.submit({ kind: "appointments.change.propose.v1", turn: turn("memo-related-cancel"),
      selection: { kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" }, now: clock() }));
  } else {
    for (const stage of ["targets", "offers"] as const) {
      resultValue(await agent.submit({ kind: "rescheduling.menu.read.v1", turn: turn(`memo-related-${stage}`), stage,
        from: stage === "targets" ? clock() : "2026-10-08", to: stage === "targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08", now: clock() }));
      await play();
      resultValue(await agent.submit({ kind: "rescheduling.menu.select.v1", turn: turn(`memo-related-choice-${stage}`), stage, choice: 1, now: clock() }));
      if (stage === "targets") await play();
    }
  }
  const action = Object.values((await f.f.state()).actions).at(-1)!;
  assert.ok(action, JSON.stringify({ claims, deniedClaims, stages }));
  assert.equal(action.status, "awaitingConfirmation"); assert.equal(f.patches.length, 0); assert.equal(memo.posts.length, 0);
  if (mode === "nativeUncertain") f.loseResponse();
  await play(); resultValue(await reception.affirm(f.f.scope, turn("memo-related-yes", "Yes"), action.key, action.digest, clock()));
  resultValue(await reception.drain(f.f.scope, f.f.callId, clock()));
  const retained = (await f.f.state()).actions[action.key]!;
  assert.equal(f.patches.length, 1); assert.equal(f.patches[0]!.id, "91"); assert.equal(f.patches[0]!.kind, operation);
  if (operation === "cancel") assert.notEqual(f.rows.get("91")!.cancelled_at, null);
  else assert.notEqual(f.rows.get("91")!.starts_at, targetBefore!.starts_at);
  assert.deepEqual(f.rows.get("93"), callerBefore); assert.deepEqual(f.rows.get("92"), otherBefore);
  const review = resultValue(decodeClinikoReview(f.f.recalls[0]!.notes));
  assert.equal(review.request.patientId, subjects[0]); assert.equal(review.request.operation.kind, operation);
  const uncertain = mode === "nativeUncertain" || mode === "fastBudgetExhausted", denied = mode === "wrongSubjectGrant" || mode === "withdrawn";
  if (uncertain) {
    assert.ok(["uncertain", "needsReview"].includes(retained.status));
    assert.equal(memo.posts.length, 0); assert.equal(memo.rows.length, 0); assert.equal(memo.consumed.size, 0);
  } else {
    assert.equal(retained.status, "committed", JSON.stringify({ claims, ...f.writeDiagnostics() })); await memo.memoSettled;
    assert.equal(memo.posts.length, denied ? 0 : 1); assert.equal(memo.rows.length, denied ? 0 : 1);
    assert.equal(memo.outcomes[0]!.kind, denied ? "unavailable" : mode === "lostStored" ? "uncertain" : "accepted");
    assert.equal(memo.consumed.size, denied ? 0 : 1);
    if (!denied) {
      const decoded = resultValue(decodeAdministrativeMemo(memo.posts[0]!.content));
      assert.equal(decoded.patientId, subjects[0]); assert.notEqual(decoded.patientId, verificationCanaries[2]);
      assert.equal(decoded.direction, "inbound"); assert.equal(decoded.sourceActionRef, review.marker);
      assert.equal(decoded.outcome.kind, operation === "cancel" ? "cancellationObserved" : "reschedulingObserved");
      assert.deepEqual(resultValue(await memo.config.barrier.claimOnce(decoded.actionRef)), { claimed: false });
    }
  }
  const publicData = JSON.stringify([commandProgress(await f.f.state(), "representative-memo-change"), (await f.f.state()).callerMessages, await flow.publicIntentContext()]);
  const secrets = [...subjects, ...f.mail.flatMap(row => [row.email, row.code]), String(f.f.recalls[0]!.notes), review.marker,
    ...[...f.r.patients.values()].flatMap(row => [row.first_name, row.last_name, row.date_of_birth, row.email]),
    ...memo.posts.map(row => String(row.content)), memo.key.toString("hex"), memo.key.toString("base64")];
  for (const [index, secret] of secrets.entries()) assert.equal(publicData.includes(secret), false, `private canary index ${index}`);
  await reception.affirm(f.f.scope, turn("memo-related-retry", "Yes"), action.key, action.digest, clock());
  resultValue(await reception.drain(f.f.scope, f.f.callId, clock()));
  assert.equal(f.patches.length, 1); assert.equal(memo.posts.length, uncertain || denied ? 0 : 1);
  assert.deepEqual((await f.f.state()).actions[action.key], retained); if (mode === "fastBudgetExhausted") assert.ok(deniedClaims > 0);
  else assert.equal(deniedClaims, 0, `shared rolling180 budget denied after ${claims} physical claims`);
});
