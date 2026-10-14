import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoClassSession } from "../../src/standalone/cliniko-class-session.ts";
import type { ClinikoClassSessionConfig } from "../../src/standalone/cliniko-class-session.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { classBookingFixture } from "../support/class-booking.ts";
import { classCancellationFixture } from "../support/class-cancellation.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

for (const operation of ["book", "cancel"] as const) {
  test(`E2E-394 admitted class ${operation} owns a fresh operation verifier, actual SAM and one inspected attendance write`, async () => {
    const f = await (operation === "book" ? classBookingFixture() : classCancellationFixture());
    let session: ClinikoClassSession | undefined;
    try {
      session = resultValue(await ClinikoClassSession.create(f.classSessionConfig));
      assert.equal(session.operation, operation);
      assert.equal(await session.verified(), undefined, "the fixture's verifier cannot grant the admitted class session");
      assert.equal(f.mail.length, 0);
      await f.play();
      assert.match(session.beginVerification().prompt, /verification code/);
      for (let i = 0; i < 100 && !f.mail.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(f.mail.length, 1);
      assert.equal((await session.submitCode(f.mail[0]!.code)).verified, true);
      const grant = await session.verified(); assert.ok(grant);
      assert.equal(await f.session.verified(), undefined);
      const reception = new TextReception(f.ledger, f.policies, session.effects, undefined, session.appointments, undefined, undefined, () => verificationNow);
      const gateway = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
      if (operation === "book") {
        resultValue(await reception.readBookingMenu(f.scope, f.turn("menu"), "2026-10-08", "2026-10-08", verificationNow));
        await f.play();
        resultValue(await reception.selectBookingMenu(f.scope, f.turn("choice"), 1, verificationNow));
      } else {
        resultValue(await gateway.submit({ kind: "appointments.read.v1", turn: f.turn("read"), verificationRef: grant.verificationRef, from: verificationNow, to: "2026-10-09T10:00:00.000Z", now: verificationNow }));
        await f.play();
        resultValue(await gateway.submit({ kind: "appointments.change.propose.v1", turn: f.turn("cancel"), selection: { kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" }, now: verificationNow }));
      }
      const action = Object.values((await f.state()).actions).at(-1)!;
      assert.equal(action.status, "awaitingConfirmation");
      assert.equal(f.writes.length, 0);
      await f.play();
      resultValue(await reception.affirm(f.scope, f.turn("confirm", "Yes"), action.key, action.digest, verificationNow));
      resultValue(await reception.drain(f.scope, f.callId, verificationNow));
      assert.equal((await f.state()).actions[action.key]!.status, "committed");
      assert.equal(f.recalls.length, 1); assert.equal(f.writes.length, 1); assert.ok(f.claims <= 200);
    } finally { session?.dispose(); await f.close(); }
  });
}

for (const fault of ["caller", "class", "fees", "scope", "call", "session", "operation", "stop", "ended", "aborted", "representative", "budget"] as const)
  test(`E2E-394 class session ${fault} mismatch denies preparation without code delivery or native mutation`, async () => {
    const f = await classCancellationFixture();
    try {
      const config = { ...f.classSessionConfig };
      if (fault === "caller") config.callerApprovalPath = f.path;
      if (fault === "class") config.classApprovalPath = f.cancellationPath;
      if (fault === "fees") config.cancellationApprovalPath = f.path;
      if (fault === "scope") config.receipt = { ...config.receipt, scope: { ...f.scope, locationId: "other" } };
      if (fault === "call") config.receipt = { ...config.receipt, callId: "other-call" };
      if (fault === "session") config.sessionId = "other-session";
      if (fault === "operation") await f.replaceApproval({ operations: ["appointments.book"] });
      if (fault === "stop") resultValue(await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop"));
      if (fault === "ended") resultValue(await f.runtime.endCall(f.callId, f.sessionId, verificationNow));
      if (fault === "aborted") config.signal = AbortSignal.abort();
      const patched = fault === "representative" ? { ...config, representative: {} } : fault === "budget" ? { ...config, cliniko: { ...config.cliniko, rateBudget: {} } } : config;
      const created = await ClinikoClassSession.create(patched as ClinikoClassSessionConfig);
      if (created.ok) created.value.dispose();
      assert.equal(created.ok, false);
      assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
    } finally { await f.close(); }
  });

for (const fault of ["patient", "class", "permission", "closed"] as const)
  test(`E2E-394 prepared class session rechecks ${fault} before releasing an operation grant`, async () => {
    const f = await classCancellationFixture();
    let session: ClinikoClassSession | undefined;
    try {
      session = resultValue(await ClinikoClassSession.create(f.classSessionConfig));
      await f.play(); session.beginVerification();
      for (let i = 0; i < 100 && !f.mail.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(f.mail.length, 1);
      if (fault === "patient") f.setPhone("+61400999888");
      if (fault === "class") await f.replacePolicy({ enabled: false });
      if (fault === "permission") f.setPermitted(false);
      if (fault === "closed") session.dispose();
      assert.equal((await session.submitCode(f.mail[0]!.code)).verified, false);
      assert.equal(await session.verified(), undefined);
      assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    } finally { session?.dispose(); await f.close(); }
  });
