import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { representativeChangeCallFixture } from "../support/representative-change-call.ts";
import { syntheticTaskSequence } from "../support/call-task-sequence.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

type Operation = "cancel" | "reschedule";
async function fixture(first: Operation) {
  let current = verificationNow;
  const underlying = new ClinikoReadBudget(180, () => Date.parse(current));
  let allowed = 0, denied = 0;
  const byWindow = new Map<number, number>();
  // Keep the exact production-shaped budget object, including headroom and
  // reservations and their object-bound context; observe claim without a stub.
  const budget = underlying, originalClaim = underlying.claim.bind(underlying);
  budget.claim = () => { const result = originalClaim(); result ? denied++ : allowed++;
    if (!result) byWindow.set(Date.parse(current), (byWindow.get(Date.parse(current)) ?? 0) + 1); return result; };
  const f = await representativeChangeCallFixture(first, { budget }); f.flow.dispose();
  const source = await syntheticTaskSequence(f.flowConfig, f.f.folder);
  await source.replace({ patientSelection: "independentlyVerifiedPatients" });
  const flow = resultValue(ClinikoCallFlow.create(source.config));
  const reception = new TextReception(f.f.ledger, f.f.policies, flow, undefined, {
    list: (...args) => flow.appointments!.list(...args), select: (...args) => flow.appointments!.select!(...args) });
  const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.f.scope }, f.f.policies,
    reception, undefined, undefined, undefined, f.f.ledger);
  let sequence = 0;
  const turn = (text: string) => ({ ...f.f.turn(`cross-operation-${++sequence}`, text), at: current });
  const play = async () => {
    const id = (await f.f.state()).pendingPresentationId; if (!id) return;
    resultValue(await f.f.runtime.startPresentation(f.f.callId, id, f.f.sessionId, current));
    resultValue(await f.f.runtime.resolvePresentation(f.f.callId, id, "played", f.f.sessionId, current));
  };
  const nextWindow = async () => {
    // Controlled source time, not an observed real-time/carrier wait. Renew
    // the existing 30-second lease before each expiry, without extending it.
    const began = Date.parse(current);
    for (const seconds of [20, 40, 61]) {
      current = new Date(began + seconds * 1000).toISOString();
      f.f.setTime(current);
      const lease = (await f.f.state()).sessionLease!;
      resultValue(await f.f.runtime.renewSession(f.f.callId, f.f.sessionId, lease.version, current));
    }
    assert.equal(underlying.checkHeadroom(180), null);
  };
  const approveSecondPatient = () => {
    // A separate synthetic clinic issuer supplies a NEW grant before subject
    // selection. Keep the original120s lifetime and first subject grant intact;
    // neither a caller turn nor an existing proof can renew clinic authority.
    const old = f.r.authorizations.get("44")!;
    f.r.authorizations.set("44", { ...old, authorityRef: "fresh-second-task-guardian",
      version: "2", expiresAt: new Date(Date.parse(current) + 120_000).toISOString() });
  };
  const counts = () => JSON.stringify({ allowed, denied, patches: f.patches.length, reviews: f.f.recalls.length, mail: f.mail.length });
  const start = async (operation: Operation, id: "43" | "44") => {
    const sent = f.mail.length;
    resultValue(await reception.startWorkflow(f.f.scope, turn("Change an appointment for another patient"), operation,
      current, (await f.f.state()).conversationRevision, undefined, false, undefined, true)); await play();
    const owner = flow.representativeInputOwner; assert.ok(owner, counts());
    assert.equal(owner.beginCallerVerification(), true); await f.waitForMail(sent + 1);
    assert.equal((await owner.submitCallerCode(f.mail.at(-1)!.code)).verified, true, counts());
    const patient = f.r.patients.get(id)!;
    resultValue(await owner.selectPatient({ firstName: patient.first_name, lastName: patient.last_name, dateOfBirth: patient.date_of_birth }));
    assert.equal(owner.beginPatientVerification(), true); await f.waitForMail(sent + 2);
    assert.equal((await flow.submitCode(f.mail.at(-1)!.code)).verified, true, counts());
    // Match the already qualified representative memo timing contract: the
    // quota pause follows verification and precedes menus, proposals and their
    // original action deadlines. This source control advances only its clock;
    // real elapsed signed/media/SQL waiting remains a separate gate.
    if (operation === "reschedule") await nextWindow();
    return owner;
  };
  const perform = async (operation: Operation) => {
    if (operation === "cancel") {
      const grant = await flow.cancellationProof(); assert.ok(grant, counts());
      resultValue(await agent.submit({ kind: "appointments.read.v1", turn: turn("Read cancellation appointments"),
        verificationRef: grant.verificationRef, from: current, to: "2026-10-09T06:00:00.000Z", now: current })); await play();
      resultValue(await agent.submit({ kind: "appointments.change.propose.v1", turn: turn("Cancel selected appointment"),
        selection: { kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" }, now: current }));
    } else {
      for (const stage of ["targets", "offers"] as const) {
        resultValue(await agent.submit({ kind: "rescheduling.menu.read.v1", turn: turn("Read move menu"), stage,
          from: stage === "targets" ? current : "2026-10-08", to: stage === "targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08", now: current }));
        assert.match((await f.f.state()).callerMessages.at(-1)!, /Option one/i, counts()); await play();
        resultValue(await agent.submit({ kind: "rescheduling.menu.select.v1", turn: turn("Select move option"), stage, choice: 1, now: current }));
        if (stage === "targets") await play();
      }
    }
    const action = Object.values((await f.f.state()).actions).at(-1)!; assert.ok(action, counts());
    assert.equal(action.status, "awaitingConfirmation", counts());
    const patches = f.patches.length;
    assert.equal((await reception.affirm(f.f.scope, turn("Yes before playback"), action.key, action.digest, current)).ok, false);
    assert.equal(f.patches.length, patches); await play();
    resultValue(await reception.affirm(f.f.scope, turn("Yes"), action.key, action.digest, current));
    resultValue(await reception.drain(f.f.scope, f.f.callId, current)); await play();
    return (await f.f.state()).actions[action.key]!;
  };
  return { ...f, source, flow, reception, start, perform, turn, counts, nextWindow, approveSecondPatient, diagnostics: () => ({ allowed, denied, claimsPerSourceWindow: [...byWindow.values()] }), assertWindowBounds: () => { for (const count of byWindow.values()) assert.ok(count <= 180); }, now: () => current,
    closeProbe: async () => { flow.dispose(); await f.close(); } };
}

for (const order of [["cancel", "reschedule"], ["reschedule", "cancel"]] as const) {
  test(`E2E-389 separately approved patient ${order[0]} then ${order[1]} preserves fresh proof, current grants and earlier receipts`, { timeout: 120_000 }, async context => {
    const f = await fixture(order[0]);
    try {
      const caller = structuredClone(f.rows.get("93"));
      const firstOwner = await f.start(order[0], "43");
      const first = await f.perform(order[0]); assert.equal(first.status, "committed", f.counts());
      await f.nextWindow(); f.approveSecondPatient();
      const secondOwner = await f.start(order[1], "44");
      assert.notEqual(secondOwner, firstOwner); assert.equal(firstOwner.closed, true);
      assert.equal((await firstOwner.submitCallerCode(f.mail[0]!.code)).verified, false);
      assert.deepEqual((await f.f.state()).actions[first.key], first);
      assert.equal((await f.flow.publicIntentContext())?.lastAction, null);
      const second = await f.perform(order[1]); assert.equal(second.status, "committed", f.counts());
      assert.deepEqual(f.patches.map(row => [row.id, row.kind]), [["91", order[0]], ["92", order[1]]]);
      assert.deepEqual((await f.f.state()).actions[first.key], first); assert.deepEqual(f.rows.get("93"), caller);
      assert.equal(f.mail.length, 4); assert.equal(f.f.recalls.length, 2); f.assertWindowBounds();
      assert.deepEqual(await f.flow.write(first.mutation, f.now()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
      const current = await f.f.state();
      assert.equal((await f.flow.startWorkflow({ scope: f.f.scope, callId: f.f.callId, sessionId: f.f.sessionId,
        policyVersion: f.flowConfig.policyVersion, operation: "cancel", forAnotherPerson: true,
        expectedConversationRevision: current.conversationRevision, signal: new AbortController().signal })).ok, false);
      assert.equal(f.patches.length, 2); assert.equal(f.mail.length, 4);
      const secrets = [...f.r.patients.values()].flatMap(row => [row.first_name, row.last_name, row.date_of_birth, row.email]).concat(f.mail.map(row => row.code));
      const publicState = JSON.stringify([await f.f.state(), await f.flow.publicIntentContext()]);
      for (const secret of secrets) assert.equal(publicState.includes(secret), false);
    } finally { context.diagnostic(JSON.stringify(f.diagnostics())); await f.closeProbe(); }
  });
}

for (const firstOperation of ["cancel", "reschedule"] as const) {
  test(`E2E-389 uncertain representative ${firstOperation} refuses another patient task without proof or replay`, { timeout: 120_000 }, async context => {
    const f = await fixture(firstOperation);
    try {
      const owner = await f.start(firstOperation, "43"); f.loseResponse();
      const first = await f.perform(firstOperation); assert.ok(["uncertain", "needsReview"].includes(first.status), f.counts());
      assert.equal(await f.flow.representativeStartupAvailable("cancel"), false);
      const current = await f.f.state();
      assert.equal((await f.flow.startWorkflow({ scope: f.f.scope, callId: f.f.callId, sessionId: f.f.sessionId,
        policyVersion: f.flowConfig.policyVersion, operation: "cancel", forAnotherPerson: true,
        expectedConversationRevision: current.conversationRevision, signal: new AbortController().signal })).ok, false);
      assert.equal(f.flow.representativeInputOwner, owner); assert.equal(f.mail.length, 2); assert.equal(f.patches.length, 1);
      assert.deepEqual((await f.f.state()).actions[first.key], first);
      assert.deepEqual(await f.flow.write(first.mutation, f.now()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
      assert.equal(f.patches.length, 1);
    } finally { context.diagnostic(JSON.stringify(f.diagnostics())); await f.closeProbe(); }
  });
}
