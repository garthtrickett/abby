import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoBookingGuard } from "../../src/standalone/cliniko-booking-guard.ts";
import { bookingOffersFixture } from "../support/booking-offers.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

test("E2E-387 actual booking guard native read receipt is one-use and rejects arbitrary receipts and altered queries", async t => {
  const f = await bookingOffersFixture();
  try {
    const proof = await f.verify(), choices = resultValue(await f.list(proof));
    const guard = new ClinikoBookingGuard({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
      ledger: f.ledger, policy: f.policies, proof: f.session.proof, authority: f.source, writer: f.writer, clock: f.sessionConfig.clock });
    const original = f.source.resolve.bind(f.source); let witnessed = false;
    t.mock.method(f.source, "resolve", async (...args: Parameters<typeof original>) => {
      const [query, target, read] = args; assert.ok(read); assert.equal(target, undefined);
      assert.equal((await original(query, undefined, { source: guard, receipt: {} })).ok, false);
      // A wrong query consumes its own receipt; it cannot be recycled to
      // validate the original after the foreign request failed.
      assert.equal(read.source.consumeNativeRead({}, query, f.session.proof), false);
      const result = await original(...args); assert.equal(result.ok, true);
      assert.equal((await original(query, undefined, read)).ok, false);
      assert.equal((await original({ ...query, offerRef: "foreign-offer" }, undefined, read)).ok, false);
      witnessed = true; return result;
    });
    assert.equal((await guard.resolve(f.scope, proof, choices.choices[0]!.offerRef, verificationNow, "proposal", new AbortController().signal)).ok, true);
    assert.equal(witnessed, true); assert.equal(f.posts, 0); guard.dispose();
  } finally { await f.close(); }
});

test("E2E-387 fresh native proof after the guarded availability read detects changed contact and withdrawn patient permission", async () => {
  for (const fault of ["contact", "permission"] as const) {
    let changedContact = false;
    const f = await bookingOffersFixture({ fetchAround: base => async (value, init) => {
      const response = await base(value, init);
      if (changedContact && new URL(String(value)).pathname.startsWith("/v1/patients/"))
        return Response.json({ ...await response.json(), email: "withdrawn-private@example.test" });
      return response;
    } });
    try {
      const proof = await f.verify(), choices = resultValue(await f.list(proof));
      const guard = new ClinikoBookingGuard({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
        ledger: f.ledger, policy: f.policies, proof: f.session.proof, authority: f.source, writer: f.writer, clock: f.sessionConfig.clock });
      f.setOnTimes(async () => { if (fault === "contact") changedContact = true; else f.setPermitted(false); });
      assert.equal((await guard.resolve(f.scope, proof, choices.choices[0]!.offerRef, verificationNow, "proposal", new AbortController().signal)).ok, false);
      assert.equal(f.posts, 0); assert.equal(f.recalls.length, 0); guard.dispose();
    } finally { await f.close(); }
  }
});
