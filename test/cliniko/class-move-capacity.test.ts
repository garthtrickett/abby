import assert from "node:assert/strict";
import test from "node:test";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

for (const different of [false, true])
  test(`E2E-402 ${different ? "cross-service" : "same-service"} class capacity wait preserves consent without dispatch and requires a fresh affirmative after recovery`, async () => {
    const f = await classMoveFixture(different);
    try {
      await f.verify(); const action = await f.prepare(); await f.play();
      // Exhaust the account using actual claims, without changing its 180 limit.
      while (await f.config.cliniko.rateBudget.claim() === null) { /* shared work */ }
      const claims = f.claims;
      for (let attempt = 0; attempt < 2; attempt++) {
        const waiting = resultValue(await f.reception.affirm(f.scope, f.turn(`wait-${attempt}`, "Yes"), action.key, action.digest, verificationNow));
        assert.equal(waiting.actions[action.key]!.status, "awaitingConfirmation");
        const notice = waiting.presentations[waiting.pendingPresentationId!]!;
        assert.equal(notice.kind, "notice"); if (notice.kind !== "notice") throw new Error("missing wait notice");
        assert.equal(notice.confirmationWaitSeconds, 60);
        assert.match(notice.approvedText, /say yes again/); assert.match(notice.approvedText, /not reserved/);
        assert.equal(Object.values(waiting.effects).some(effect => effect.kind === "hostWrite"), false);
        await f.play(); resultValue(await f.reception.drain(f.scope, f.callId, verificationNow));
        assert.equal(f.claims, claims, "preflight and drain neither reserve quota nor send a native request");
        assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
      }
      await f.pause(61); const now = f.classSessionConfig.clock();
      assert.equal((await f.state()).actions[action.key]!.status, "awaitingConfirmation");
      assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null);
      resultValue(await f.reception.affirm(f.scope, f.turn("confirm-after-wait", "Yes"), action.key, action.digest, now));
      resultValue(await f.reception.drain(f.scope, f.callId, now));
      assert.equal((await f.state()).actions[action.key]!.status, "committed");
      assert.deepEqual(f.writes.map(row => row.path), ["/v1/attendees", "/v1/attendees/101/cancel"]);
      assert.equal(f.recalls.length, 1); assert.ok(f.windowClaims.every(count => count <= 180));
    } finally { await f.close(); }
  });

for (const fault of ["permission", "approval", "expiry", "correction"] as const)
  test(`E2E-402 ${fault} during class capacity wait cannot reuse earlier consent`, async () => {
    const f = await classMoveFixture(true);
    try {
      await f.verify(); const action = await f.prepare(); await f.play();
      resultValue(await f.reception.affirm(f.scope, f.turn("wait", "Yes"), action.key, action.digest, verificationNow)); await f.play();
      if (fault === "permission") f.permit(false);
      if (fault === "approval") await f.replaceMove({ enabled: false });
      await f.pause(fault === "expiry" ? 121 : 61);
      const now = f.classSessionConfig.clock();
      if (fault === "correction") resultValue(await f.runtime.nonAffirmativeFinal(f.turn("correction", "No, another day"), (await f.state()).conversationRevision, now));
      await f.reception.affirm(f.scope, f.turn("late-yes", "Yes"), action.key, action.digest, now);
      resultValue(await f.reception.drain(f.scope, f.callId, now));
      assert.equal((await f.state()).actions[action.key]!.status, "canceled");
      assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
      assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null);
    } finally { await f.close(); }
  });

for (const fault of ["bargeIn", "correction", "permission"] as const)
  test(`E2E-402 a pending capacity read cannot affirm after ${fault}`, async () => {
    const f = await classMoveFixture(true);
    try {
      await f.verify(); const action = await f.prepare(); await f.play();
      let started!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const budget = f.config.cliniko.rateBudget, original = budget.checkHeadroom;
      assert.ok(original);
      Object.defineProperty(budget, "checkHeadroom", { value: async (requests: number) => { started(); await gate; return original.call(budget, requests); } });
      const stop = new AbortController(), pending = f.reception.affirm(f.scope, f.turn("pending-yes", "Yes"), action.key, action.digest, verificationNow, undefined, stop.signal);
      await entered;
      if (fault === "bargeIn") stop.abort();
      if (fault === "correction") resultValue(await f.runtime.nonAffirmativeFinal(f.turn("new-turn", "No, another time"), (await f.state()).conversationRevision, verificationNow));
      if (fault === "permission") f.permit(false);
      release(); const settled = await pending;
      if (fault === "bargeIn" || fault === "correction") { assert.equal(settled.ok, false); if (!settled.ok) assert.equal(settled.error.kind, "staleTurn"); }
      resultValue(await f.reception.drain(f.scope, f.callId, verificationNow));
      assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
      assert.equal((await f.state()).actions[action.key]!.status, fault === "bargeIn" ? "awaitingConfirmation" : "canceled");
    } finally { await f.close(); }
  });
