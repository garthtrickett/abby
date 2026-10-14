import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoClassSession } from "../../src/standalone/cliniko-class-session.ts";
import type { ClinikoClassSessionConfig } from "../../src/standalone/cliniko-class-session.ts";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";

async function begin(f: Awaited<ReturnType<typeof classMoveFixture>>, session: ClinikoClassSession) {
  await f.play(); session.beginVerification();
  for (let i = 0; i < 100 && !f.mail.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.mail.length, 1);
}

for (const different of [false, true])
  test(`E2E-399 admitted class movement owns fresh operation proof and exact SAM ${different ? "service replacement" : "occurrence change"}`, async () => {
    const f = await classMoveFixture(different);
    let session: ClinikoClassSession | undefined;
    try {
      session = resultValue(await ClinikoClassSession.create(f.classSessionConfig));
      assert.equal(session.operation, "reschedule"); assert.ok(session.rescheduling);
      assert.equal(session.booking, undefined); assert.equal(session.appointments, undefined);
      assert.equal(await session.verified(), undefined);
      await begin(f, session);
      assert.equal((await session.submitCode(f.mail[0]!.code)).verified, true);
      assert.equal(await f.session.verified(), undefined, "a new owner must not grant the old verifier");
      const reception = new TextReception(f.ledger, f.policies, session.effects, undefined, undefined, undefined, undefined, f.classSessionConfig.clock);
      const action = await f.prepare(reception);
      assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
      if (different) await f.pause(61);
      const now = f.classSessionConfig.clock(); await f.play();
      resultValue(await reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, now));
      resultValue(await reception.drain(f.scope, f.callId, now));
      assert.equal((await f.state()).actions[action.key]!.status, "committed");
      assert.deepEqual(f.writes.map(row => row.path), ["/v1/attendees", "/v1/attendees/101/cancel"]);
      assert.equal(f.recalls.length, 1); assert.ok(f.windowClaims.every(count => count <= 180));
      for (const secret of [...verificationCanaries, f.mail[0]!.code]) assert.equal(JSON.stringify((await f.state()).callerMessages).includes(secret), false);
    } finally { session?.dispose(); await f.close(); }
  });

for (const fault of ["caller", "source", "destination", "move", "scope", "call", "session", "operation", "stop", "ended", "aborted", "representative", "budget"] as const)
  test(`E2E-399 admitted move rejects ${fault} before code delivery or native mutation`, async () => {
    const f = await classMoveFixture(true);
    try {
      const config = { ...f.classSessionConfig };
      if (fault === "caller") config.callerApprovalPath = f.sourcePath;
      if (fault === "source") config.classApprovalPath = f.movePath;
      if (fault === "destination") config.destination = { ...config.destination, practitionerId: "22" };
      if (fault === "move") config.moveApprovalPath = f.sourcePath;
      if (fault === "scope") config.receipt = { ...config.receipt, scope: { ...f.scope, locationId: "other" } };
      if (fault === "call") config.receipt = { ...config.receipt, callId: "other" };
      if (fault === "session") config.sessionId = "other";
      if (fault === "operation") await f.replaceApproval({ operations: ["appointments.cancel"] });
      if (fault === "stop") resultValue(await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop"));
      if (fault === "ended") resultValue(await f.runtime.endCall(f.callId, f.sessionId, verificationNow));
      if (fault === "aborted") config.signal = AbortSignal.abort();
      const patched = fault === "representative" ? { ...config, representative: {} } : fault === "budget" ? { ...config, cliniko: { ...config.cliniko, rateBudget: {} } } : config;
      const result = await ClinikoClassSession.create(patched as ClinikoClassSessionConfig);
      if (result.ok) result.value.dispose();
      assert.equal(result.ok, false); assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
    } finally { await f.close(); }
  });

for (const fault of ["caller", "source", "destination", "move", "patient", "permission", "stop", "closed"] as const)
  test(`E2E-399 admitted move rechecks ${fault} before accepting a delivered code`, async () => {
    const f = await classMoveFixture(true);
    let session: ClinikoClassSession | undefined;
    try {
      session = resultValue(await ClinikoClassSession.create(f.classSessionConfig));
      await begin(f, session);
      if (fault === "caller") await f.replaceApproval({ enabled: false });
      if (fault === "source") await f.replaceSource({ enabled: false });
      if (fault === "destination") await f.replaceDestination({ enabled: false });
      if (fault === "move") await f.replaceMove({ enabled: false });
      if (fault === "patient") f.setPhone("+61400999888");
      if (fault === "permission") f.setPermitted(false);
      if (fault === "stop") resultValue(await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop"));
      if (fault === "closed") session.dispose();
      assert.equal((await session.submitCode(f.mail[0]!.code)).verified, false);
      assert.equal(await session.verified(), undefined); assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
    } finally { session?.dispose(); await f.close(); }
  });

test("E2E-399 prior caller proof cannot grant a newly admitted class move owner", async () => {
  const f = await classMoveFixture();
  let session: ClinikoClassSession | undefined;
  try {
    await f.verify(); assert.ok(await f.session.verified());
    session = resultValue(await ClinikoClassSession.create(f.classSessionConfig));
    assert.equal(await session.verified(), undefined);
    assert.equal(f.mail.length, 1); assert.equal(f.writes.length, 0);
  } finally { session?.dispose(); await f.close(); }
});
