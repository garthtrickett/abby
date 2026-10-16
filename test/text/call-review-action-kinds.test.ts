import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ActionRequest, ActionState } from "../../src/core/model.ts";
import { CallReview, summarizeCall } from "../../src/reference/call-review.ts";
import { CallOutcomeReport } from "../../src/reference/call-outcome-report.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { now, setup } from "./fixture.ts";

for (const kind of ["patientUpdate", "confirmationResend"] as const)
  for (const outcome of ["committed", "uncertain"] as const)
    test(`E2E-362/E2E-373 call review and outcome gateway preserve ${outcome} ${kind} without private references`, async () => {
      const version = "a".repeat(64), app = await setup(`review-${kind}-${outcome}-${randomUUID()}`,
        { [kind]: "execute" }, undefined, { confirmationResendVersion: version });
      const privateRef = `private-reader-${randomUUID()}`, privateHostRef = `private-host-${randomUUID()}`;
      const request: ActionRequest = kind === "patientUpdate"
        ? { kind, patient: { ...app.patient, expiresAt: "2026-09-28T10:04:00.000Z" }, correctionRef: privateRef,
          consentRef: `consent-${randomUUID()}`, correctionVersion: "1", expiresAt: "2026-09-28T10:03:00.000Z" }
        : { kind, scope: app.scope, requestRef: randomUUID(), resendVersion: version, expiresAt: "2026-09-28T10:02:00.000Z" };
      await app.turn("request", "Private reader regression caller text", { kind: "requestAction", request });
      const action = await app.pendingAction();
      await app.confirm(action.key);
      app.host.writeResult = mutation => outcome === "committed"
        ? { kind: "committed", actionKey: mutation.actionKey, hostRef: privateHostRef }
        : { kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline: "2026-09-28T10:05:00.000Z" };
      await app.worker.process(app.callId, `${action.key}:write`, now);
      assert.equal((await app.state()).actions[action.key]?.status, outcome);

      const policy = new MemoryPolicyStore(), reception = new TextReception(app.ledger, policy, app.host);
      const review = new CallReview(app.ledger), report = new CallOutcomeReport(app.ledger);
      const gateway = new CommandGateway({ actorRef: "reader-staff", role: "staff", scope: app.scope },
        policy, reception, review, undefined, report);
      const summary = await gateway.submit({ kind: "calls.read.v1", callId: app.callId });
      assert.ok(summary.ok && summary.value.kind === "callSummary", JSON.stringify(summary));
      assert.deepEqual(summary.value.call.actions, [{ kind, status: outcome }]);
      const outcomes = await gateway.submit({ kind: "calls.outcomes.v1" });
      assert.ok(outcomes.ok && outcomes.value.kind === "callOutcomes", JSON.stringify(outcomes));
      assert.equal(outcomes.value.page.rows.length, 1);
      assert.equal(outcomes.value.page.rows[0]?.committedActions, Number(outcome === "committed"));
      assert.equal(outcomes.value.page.rows[0]?.unresolvedActions, Number(outcome === "uncertain"));
      for (const result of [summary, outcomes]) {
        const serialized = JSON.stringify(result);
        for (const value of [privateRef, privateHostRef, app.patient.patientRef, app.patient.verificationRef,
          "Private reader regression caller text", request.kind === "confirmationResend" ? request.requestRef : request.consentRef])
          assert.equal(serialized.includes(value), false);
      }

      const foreign = new CommandGateway({ actorRef: "foreign-staff", role: "staff", scope: { ...app.scope, tenantId: "foreign" } },
        policy, reception, review, undefined, report);
      assert.deepEqual(await foreign.submit({ kind: "calls.read.v1", callId: app.callId }), { ok: false, error: { kind: "callUnknown" } });
      const hidden = await foreign.submit({ kind: "calls.outcomes.v1" });
      assert.ok(hidden.ok && hidden.value.kind === "callOutcomes");
      assert.equal(hidden.value.page.rows.length, 0);
      for (const invalid of ["private-unknown-kind", "constructor", "__proto__", null, {}]) {
        const corrupt = structuredClone(await app.state());
        corrupt.actions[action.key] = { ...corrupt.actions[action.key], kind: invalid } as unknown as ActionState;
        assert.deepEqual(summarizeCall(corrupt), { ok: false, error: { kind: "storageCorrupt" } });
      }
      assert.equal(app.host.writes.length, 1, "review and reporting never dispatch another patient action");
    });
